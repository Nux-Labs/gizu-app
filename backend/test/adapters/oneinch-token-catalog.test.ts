import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
import { OneInchTokenCatalog } from "../../src/adapters/oneinch/token-catalog.ts";
import { ROBINHOOD_BUY_TARGETS, robinhoodBuyRank } from "../../src/adapters/oneinch/swap-targets.ts";

const stock = "0x1111111111111111111111111111111111111111";
const unrelated = "0x2222222222222222222222222222222222222222";
const unlisted = "0x3333333333333333333333333333333333333333";
const ordinary = "0x4444444444444444444444444444444444444444";

function fakeFetch(requests: Array<{ url: string; authorization: string | null }>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.includes("robinhood.com")) {
      return Response.json({ assets: [
        { tokenSymbol: "AAPL", tokenName: "Apple Robinhood Token", tokenDecimals: 18, status: "ASSET_STATUS_ACTIVE", logoUrl: "https://cdn.robinhood.com/aapl.png", deployments: [{ chainId: 4663, contractAddress: stock }] },
        { tokenSymbol: "MSFT", tokenName: "Microsoft Robinhood Token", tokenDecimals: 6, status: "ASSET_STATUS_ACTIVE", logoUrl: "https://cdn.robinhood.com/msft.png", deployments: [{ chainId: 4663, contractAddress: unlisted }] },
        { tokenSymbol: "OLD", tokenName: "Old Token", tokenDecimals: 18, status: "ASSET_STATUS_INACTIVE", logoUrl: "https://cdn.robinhood.com/old.png", deployments: [{ chainId: 4663, contractAddress: unrelated }] },
      ] });
    }
    return Response.json({ tokens: {
      [stock]: { address: stock, symbol: "AAPL", name: "Apple Robinhood Token", decimals: 18, logoURI: "", tags: [] },
      [unrelated]: { address: unrelated, symbol: "USDY", name: "Ondo US Dollar Yield", decimals: 18, logoURI: "", tags: ["rwa"] },
      [ordinary]: { address: ordinary, symbol: "USDC", name: "USD Coin", decimals: 6, logoURI: "", tags: ["tokens"] },
    } });
  };
}

test("Robinhood catalog includes active canonical assets and marks 1inch listing", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const catalog = new OneInchTokenCatalog("private-key", fakeFetch(requests));
  const result = await catalog.list(4663, "all");
  assert.deepEqual(result.map(({ symbol, swapListed, category }) => ({ symbol, swapListed, category })), [
    { symbol: "AAPL", swapListed: true, category: "rwa" },
    { symbol: "MSFT", swapListed: false, category: "rwa" },
    { symbol: "USDC", swapListed: true, category: "other" },
    { symbol: "USDY", swapListed: true, category: "rwa" },
  ]);
  assert.equal(requests[0]?.authorization, "Bearer private-key");
  assert.equal(requests[0]?.url, "https://api.1inch.com/swap/v6.1/4663/tokens");
  assert.equal(result[1]?.decimals, 6);
  assert.equal(result[1]?.logoURI, "https://cdn.robinhood.com/msft.png");
});

test("Ethereum RWA filter uses 1inch token tags without including ordinary tokens", async () => {
  const catalog = new OneInchTokenCatalog("key", fakeFetch([]));
  const result = await catalog.list(1, "rwa");
  assert.deepEqual(result.map((token) => token.symbol), ["USDY"]);
  assert.equal(result[0]?.fusionStatus, "quote-required");
});

test("DeFi filter keeps tokens without the 1inch RWA tag", async () => {
  const catalog = new OneInchTokenCatalog("key", fakeFetch([]));
  const result = await catalog.list(1, "other");
  assert.deepEqual(result.map((token) => token.symbol), ["AAPL", "USDC"]);
});

test("reuses the token catalog for 10 minutes", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const catalog = new OneInchTokenCatalog("key", fakeFetch(requests));
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await catalog.list(1, "all");
    now = 599_999;
    await catalog.list(1, "rwa");
    assert.equal(requests.length, 1);
    now = 600_000;
    await catalog.list(1, "all");
    assert.equal(requests.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("rejects malformed 1inch data instead of returning an empty catalog", async () => {
  const catalog = new OneInchTokenCatalog("key", async () => Response.json({ tokens: [] }));
  await assert.rejects(catalog.list(143, "all"), (error: unknown) => {
    assert.ok(error instanceof InfrastructureError);
    assert.equal(error.statusCode, 503);
    return true;
  });
});

test("accepts tokens without a logo in the live 1inch response", async () => {
  const catalog = new OneInchTokenCatalog("key", async () => Response.json({ tokens: {
    [stock]: { address: stock, symbol: "OUSG", name: "Ondo US Government Bonds", decimals: 18, logoURI: null, tags: ["rwa"] },
  } }));
  const result = await catalog.list(1, "rwa");
  assert.equal(result[0]?.logoURI, null);
});

test("does not infer RWA status or issuer from a token name", async () => {
  const catalog = new OneInchTokenCatalog("key", async () => Response.json({ tokens: {
    [stock]: { address: stock, symbol: "XYZ", name: "Ondo-like Token", decimals: 18, logoURI: null, tags: ["tokens"] },
  } }));
  const [token] = await catalog.list(1, "all");
  assert.equal(token?.category, "other");
  assert.equal(token?.issuer, null);
});

test("rejects missing documented token tags instead of treating them as non-RWA", async () => {
  const catalog = new OneInchTokenCatalog("key", async () => Response.json({ tokens: {
    [stock]: { address: stock, symbol: "XYZ", name: "Token", decimals: 18, logoURI: null },
  } }));
  await assert.rejects(catalog.list(1, "all"), InfrastructureError);
});

test("only curated liquid Robinhood stocks are buyable and they lead in liquidity order", async () => {
  const [first, second] = ROBINHOOD_BUY_TARGETS;
  assert.ok(first && second);
  const asset = (symbol: string, address: string) => ({ tokenSymbol: symbol, tokenName: symbol, tokenDecimals: 18, status: "ASSET_STATUS_ACTIVE", logoUrl: "https://cdn.robinhood.com/x.png", deployments: [{ chainId: 4663, contractAddress: address }] });
  const listed = (symbol: string, address: string) => ({ address, symbol, name: symbol, decimals: 18, logoURI: null, tags: [] });
  const catalog = new OneInchTokenCatalog("key", async (input) => String(input).includes("robinhood.com")
    ? Response.json({ assets: [asset("AAA", stock), asset(second.symbol, second.address), asset(first.symbol, first.address), asset("ZZZ", unlisted)] })
    : Response.json({ tokens: { [stock]: listed("AAA", stock), [second.address]: listed(second.symbol, second.address), [first.address]: listed(first.symbol, first.address) } }));
  const result = await catalog.list(4663, "rwa");
  assert.deepEqual(result.map(({ symbol, swapListed, buyable }) => ({ symbol, swapListed, buyable })), [
    { symbol: first.symbol, swapListed: true, buyable: true },
    { symbol: second.symbol, swapListed: true, buyable: true },
    { symbol: "AAA", swapListed: true, buyable: false },
    { symbol: "ZZZ", swapListed: false, buyable: false },
  ]);
});

test("backend buy targets match the shared liquidity list the native engine pins", () => {
  const shared = JSON.parse(readFileSync(new URL("../../../shared/swap-targets-v1.json", import.meta.url), "utf8")) as { version: string; chainId: number; targets: Array<{ symbol: string; address: string }> };
  assert.equal(shared.version, "gizu-swap-targets-v1");
  assert.equal(shared.chainId, 4663);
  assert.deepEqual(ROBINHOOD_BUY_TARGETS.map(({ symbol, address }) => ({ symbol, address })), shared.targets.map(({ symbol, address }) => ({ symbol, address })));
  assert.equal(robinhoodBuyRank(shared.targets[0]!.address.toUpperCase().replace("0X", "0x")), 0);
  assert.equal(robinhoodBuyRank(unlisted), undefined);
});
