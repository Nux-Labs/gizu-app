import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { FusionSDK } from "@1inch/fusion-sdk";
import { BASE_FUSION, BASE_USDC, OneInchFusion, ROBINHOOD_USDG } from "../../src/adapters/oneinch/fusion.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const stock = "0xb2000000000000000000002D0BA3164cc74f58B7";
const permit = `0x${"ab".repeat(224)}` as const;

test("a Base buy spends Base USDC by default and a Robinhood buy still spends USDG", async () => {
  const create = mock.method(FusionSDK.prototype, "createOrder", async () => ({
    hash: `0x${"ab".repeat(32)}`, quoteId: "q",
    order: { build: () => ({ salt: "1", maker: wallet, receiver: wallet, makerAsset: BASE_USDC, takerAsset: stock, makingAmount: "1", takingAmount: "1", makerTraits: "0" }), extension: { encode: () => "0x" } },
  }));
  try {
    await new OneInchFusion("test-only-key", fetch, undefined, undefined, BASE_FUSION).createOrder(wallet, stock, 1n, permit, "fast");
    await new OneInchFusion("test-only-key").createOrder(wallet, stock, 1n, permit, "fast");
    assert.equal(create.mock.calls[0]?.arguments[0]?.fromTokenAddress, BASE_USDC);
    assert.equal(create.mock.calls[1]?.arguments[0]?.fromTokenAddress, ROBINHOOD_USDG);
  } finally {
    create.mock.restore();
  }
});

test("a Base buy preview checks liquidity against Base USDC on chain 8453; a sale does not", async () => {
  const quote = mock.method(FusionSDK.prototype, "getQuote", async () => ({
    toTokenAmount: "1",
    recommendedPreset: "fast",
    settlementAddress: { toString: () => "0x2ad5004c60e16e54d5007c80ce329adde5b51ef5" },
    getPreset: () => ({ auctionStartAmount: 1n, auctionEndAmount: 1n, auctionDuration: 180n, allowPartialFills: false, allowMultipleFills: false }),
  }));
  const urls: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    urls.push(String(input));
    // The 1,000 USDC reference returns 99.5x the 10 USDC probe: 50 bps of impact.
    return Response.json({ dstAmount: new URL(String(input)).searchParams.get("amount") === "10000000" ? "1000" : "99500" });
  }) as typeof fetch;
  try {
    const fusion = new OneInchFusion("test-only-key", fetchImpl, undefined, async () => {}, BASE_FUSION);
    const preview = await fusion.preview(wallet, stock, 1_000_000n, "fast");
    assert.deepEqual(preview.liquidity, { impactBps: "50", passes: true });
    assert.equal(preview.settlement, "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5");
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.ok(url.startsWith("https://api.1inch.com/swap/v6.1/8453/quote?"), url);
      assert.equal(new URL(url).searchParams.get("src"), BASE_USDC);
    }
    await fusion.preview(wallet, BASE_USDC, 1_000_000n, "fast", stock);
    assert.equal(urls.length, 2, "a sale is never held back by the buy-side liquidity check");
  } finally {
    quote.mock.restore();
  }
});
