import assert from "node:assert/strict";
import { test } from "node:test";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
import { ROBINHOOD_BUY_TARGETS } from "../../src/adapters/oneinch/swap-targets.ts";
import { RobinhoodTokenDetails } from "../../src/adapters/oneinch/token-details.ts";
import { TOKEN_PROFILES } from "../../src/adapters/oneinch/token-profiles.ts";

const nvda = ROBINHOOD_BUY_TARGETS.find((t) => t.symbol === "NVDA")!;
const qqq = ROBINHOOD_BUY_TARGETS.find((t) => t.symbol === "QQQ")!;
const tradable = { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" };

function asset(symbol: string, address: string, extra: Record<string, unknown> = {}) {
  return {
    tokenSymbol: symbol, tokenName: `${symbol} • Robinhood Token`, logoUrl: `https://cdn.robinhood.com/${symbol}.png`,
    status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ chainId: 4663, contractAddress: address }], ...extra,
  };
}

type Replies = { robinhood?: () => Response; price?: () => Response; chart?: () => Response };
function fakeFetch(calls: string[], replies: Replies = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("robinhood.com")) {
      return replies.robinhood?.() ?? Response.json({ assets: [
        asset("NVDA", nvda.address, { isin: "US67066G1040", currentMultiplier: "1.000775159164630595", tradingCapabilities: { market: tradable, extended: tradable, overnight: { whole: "TRADING_STATUS_UNTRADABLE" } } }),
        asset("QQQ", qqq.address),
      ] });
    }
    if (url.includes("/price/")) return replies.price?.() ?? Response.json({ [nvda.address.toLowerCase()]: "176.22", [qqq.address.toLowerCase()]: "612.5" });
    return replies.chart?.() ?? Response.json({ data: [{ time: 1_792_022_400, value: 179.6 }, { time: 1_791_936_000, value: 170.2 }] });
  };
}

test("combines Robinhood's record, the 1inch price and an oldest-first chart", async () => {
  const calls: string[] = [];
  const details = await new RobinhoodTokenDetails("key", fakeFetch(calls)).details(nvda.address.toLowerCase(), "1D");
  assert.deepEqual(details, {
    chainId: 4663, address: nvda.address, symbol: "NVDA", name: "NVDA • Robinhood Token", logoURI: "https://cdn.robinhood.com/NVDA.png",
    kind: "stock", description: TOKEN_PROFILES.NVDA!.description, isin: "US67066G1040", sharesPerToken: "1.000775159164630595",
    sessions: { regular: true, extended: true, overnight: false }, priceUsd: 176.22,
    chart: { period: "1D", points: [{ time: 1_791_936_000, price: 170.2 }, { time: 1_792_022_400, price: 179.6 }] },
  });
  assert.ok(calls.some((url) => url.endsWith(`/charts/v1.0/chart/line/${nvda.address}/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168/24H/4663`)));
});

test("a fund without optional Robinhood fields still has a page", async () => {
  const details = await new RobinhoodTokenDetails("key", fakeFetch([])).details(qqq.address, "1M");
  assert.equal(details?.kind, "fund");
  assert.equal(details?.isin, null);
  assert.equal(details?.sharesPerToken, null);
  assert.deepEqual(details?.sessions, { regular: false, extended: false, overnight: false });
});

test("a missing price or chart leaves those fields empty instead of failing the page", async () => {
  const fetchImpl = fakeFetch([], { price: () => new Response("", { status: 500 }), chart: () => Response.json({ data: [{ time: 1, value: 1 }] }) });
  const details = await new RobinhoodTokenDetails("key", fetchImpl).details(nvda.address, "1W");
  assert.equal(details?.priceUsd, null);
  assert.equal(details?.chart, null);
  assert.equal(details?.symbol, "NVDA");
});

test("tokens outside the buy list have no detail page and cause no provider calls", async () => {
  const calls: string[] = [];
  assert.equal(await new RobinhoodTokenDetails("key", fakeFetch(calls)).details("0x1111111111111111111111111111111111111111", "1M"), undefined);
  assert.deepEqual(calls, []);
});

test("an unavailable Robinhood catalog is a 503", async () => {
  const service = new RobinhoodTokenDetails("key", fakeFetch([], { robinhood: () => new Response("", { status: 502 }) }));
  await assert.rejects(service.details(nvda.address, "1M"), (error: unknown) => error instanceof InfrastructureError && error.statusCode === 503);
});

test("reuses prices for a minute, charts and assets for ten minutes, and retries a failure sooner", async () => {
  const calls: string[] = [];
  let now = 0;
  let chartFails = true;
  const service = new RobinhoodTokenDetails("key", fakeFetch(calls, { chart: () => chartFails ? new Response("", { status: 500 }) : Response.json({ data: [{ time: 1, value: 1 }, { time: 2, value: 2 }] }) }), () => now);
  const count = (part: string) => calls.filter((url) => url.includes(part)).length;
  await service.details(nvda.address, "1M");
  chartFails = false;
  now = 59_999;
  assert.equal((await service.details(nvda.address, "1M"))?.chart, null);
  assert.deepEqual([count("robinhood"), count("/price/"), count("/charts/")], [1, 1, 1]);
  now = 60_000;
  assert.notEqual((await service.details(nvda.address, "1M"))?.chart, null);
  assert.deepEqual([count("robinhood"), count("/price/"), count("/charts/")], [1, 2, 2]);
  now = 600_000;
  await service.details(nvda.address, "1M");
  assert.deepEqual([count("robinhood"), count("/price/"), count("/charts/")], [2, 3, 2]);
});

test("every buy target has a kind and a description", () => {
  for (const target of ROBINHOOD_BUY_TARGETS) {
    const profile = TOKEN_PROFILES[target.symbol];
    assert.ok(profile, target.symbol);
    assert.ok(profile.description.length >= 40 && profile.description.length <= 200, target.symbol);
  }
  assert.deepEqual(Object.keys(TOKEN_PROFILES).sort(), ROBINHOOD_BUY_TARGETS.map((t) => t.symbol).sort());
});

test("one batched request prices every buy target, refreshes after a minute and feeds the detail page", async () => {
  const calls: string[] = [];
  let now = 0;
  const all = Object.fromEntries(ROBINHOOD_BUY_TARGETS.map((t, i) => [t.address.toLowerCase(), String(100 + i)]));
  const service = new RobinhoodTokenDetails("key", fakeFetch(calls, { price: () => Response.json(all) }), () => now);
  const count = () => calls.filter((url) => url.includes("/price/")).length;
  const [first, second] = await Promise.all([service.prices(), service.prices()]);
  assert.equal(count(), 1);
  assert.ok(calls.find((url) => url.includes("/price/"))!.includes(ROBINHOOD_BUY_TARGETS.map((t) => t.address).join(",")));
  assert.equal(first.size, ROBINHOOD_BUY_TARGETS.length);
  assert.equal(first.get(qqq.address.toLowerCase()), 100);
  assert.deepEqual(second, first);
  assert.equal((await service.details(nvda.address, "1M"))?.priceUsd, Number(all[nvda.address.toLowerCase()]));
  assert.equal(count(), 1);
  now = 60_000;
  await service.prices();
  assert.equal(count(), 2);
});

test("a failed batch leaves every price null without throwing", async () => {
  const service = new RobinhoodTokenDetails("key", fakeFetch([], { price: () => new Response("", { status: 429 }) }));
  const prices = await service.prices();
  assert.equal(prices.size, ROBINHOOD_BUY_TARGETS.length);
  assert.ok([...prices.values()].every((price) => price === null));
});
