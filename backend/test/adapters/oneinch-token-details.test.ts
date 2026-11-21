import assert from "node:assert/strict";
import { test } from "node:test";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
import { BASE_BUY_TARGETS, ROBINHOOD_BUY_TARGETS } from "../../src/adapters/oneinch/swap-targets.ts";
import { StockTokenDetails } from "../../src/adapters/oneinch/token-details.ts";
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
  const details = await new StockTokenDetails("key", fakeFetch(calls)).details(nvda.address.toLowerCase(), "1D");
  assert.deepEqual(details, {
    chainId: 4663, address: nvda.address, symbol: "NVDA", name: "NVDA • Robinhood Token", logoURI: "https://cdn.robinhood.com/NVDA.png",
    kind: "stock", description: TOKEN_PROFILES.NVDA!.description, isin: "US67066G1040", sharesPerToken: "1.000775159164630595",
    sessions: { regular: true, extended: true, overnight: false }, priceUsd: 176.22,
    chart: { period: "1D", source: "1inch", points: [{ time: 1_791_936_000, price: 170.2 }, { time: 1_792_022_400, price: 179.6 }] },
  });
  assert.ok(calls.some((url) => url.endsWith(`/charts/v1.0/chart/line/${nvda.address}/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168/24H/4663`)));
});

test("a fund without optional Robinhood fields still has a page", async () => {
  const details = await new StockTokenDetails("key", fakeFetch([])).details(qqq.address, "1M");
  assert.equal(details?.kind, "fund");
  assert.equal(details?.isin, null);
  assert.equal(details?.sharesPerToken, null);
  assert.deepEqual(details?.sessions, { regular: false, extended: false, overnight: false });
});

test("a missing price or chart leaves those fields empty instead of failing the page", async () => {
  const fetchImpl = fakeFetch([], { price: () => new Response("", { status: 500 }), chart: () => Response.json({ data: [{ time: 1, value: 1 }] }) });
  const details = await new StockTokenDetails("key", fetchImpl).details(nvda.address, "1W");
  assert.equal(details?.priceUsd, null);
  assert.equal(details?.chart, null);
  assert.equal(details?.symbol, "NVDA");
});

test("tokens outside the buy list have no detail page and cause no provider calls", async () => {
  const calls: string[] = [];
  assert.equal(await new StockTokenDetails("key", fakeFetch(calls)).details("0x1111111111111111111111111111111111111111", "1M"), undefined);
  assert.deepEqual(calls, []);
});

test("an unavailable Robinhood catalog is a 503", async () => {
  const service = new StockTokenDetails("key", fakeFetch([], { robinhood: () => new Response("", { status: 502 }) }));
  await assert.rejects(service.details(nvda.address, "1M"), (error: unknown) => error instanceof InfrastructureError && error.statusCode === 503);
});

test("reuses prices for a minute, charts and assets for ten minutes, and retries a failure sooner", async () => {
  const calls: string[] = [];
  let now = 0;
  let chartFails = true;
  const service = new StockTokenDetails("key", fakeFetch(calls, { chart: () => chartFails ? new Response("", { status: 500 }) : Response.json({ data: [{ time: 1, value: 1 }, { time: 2, value: 2 }] }) }), () => now);
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
  const service = new StockTokenDetails("key", fakeFetch(calls, { price: () => Response.json(all) }), () => now);
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
  const service = new StockTokenDetails("key", fakeFetch([], { price: () => new Response("", { status: 429 }) }));
  const prices = await service.prices();
  assert.equal(prices.size, ROBINHOOD_BUY_TARGETS.length);
  assert.ok([...prices.values()].every((price) => price === null));
});

test("a Base page combines Coinbase's record with the 1inch price and a chart against Base USDC", async () => {
  const googl = BASE_BUY_TARGETS[0]!;
  const calls: string[] = [];
  let coinbaseUp = true;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("coinbase.com")) {
      return coinbaseUp
        ? Response.json({ tokens: [{ contract_address: googl.address.toLowerCase(), symbol: "GOOGLc", name: "Alphabet Inc.", icon_url: "https://cdn.coinbase.com/googl.png", isin: "US02079K3059", multiplier: "1", description: "Alphabet is the parent of Google." }] })
        : new Response("", { status: 503 });
    }
    if (url.includes("/price/")) return Response.json({ [googl.address.toLowerCase()]: "301.5" });
    return Response.json({ data: [{ time: 2, value: 302 }, { time: 1, value: 300 }] });
  };
  let now = 1_000;
  const service = new StockTokenDetails("key", fetchImpl, () => now);
  const details = await service.details(googl.address, "1W", 8453);
  assert.deepEqual(details, {
    chainId: 8453, address: googl.address, symbol: "GOOGLc", name: "Alphabet Inc.", logoURI: "https://cdn.coinbase.com/googl.png",
    kind: "stock", description: "Alphabet is the parent of Google.", isin: "US02079K3059", sharesPerToken: "1", sessions: null, priceUsd: 301.5,
    chart: { period: "1W", source: "1inch", points: [{ time: 1, price: 300 }, { time: 2, price: 302 }] },
  });
  assert.ok(calls.some((url) => url.endsWith(`/charts/v1.0/chart/line/${googl.address}/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/1W/8453`)));
  assert.ok(calls.some((url) => url.startsWith(`https://api.1inch.com/price/v1.1/8453/${googl.address}`)));
  assert.equal(await service.details(googl.address, "1W"), undefined, "a Base token is not a Robinhood target");
  // A Coinbase outage after one good read keeps serving the last list.
  coinbaseUp = false;
  now += 11 * 60_000;
  assert.equal((await service.details(googl.address, "1W", 8453))?.symbol, "GOOGLc");
  // With no Coinbase list at all, the page keeps the pinned symbol and the 1inch price and chart.
  const fallback = await new StockTokenDetails("key", fetchImpl).details(googl.address, "1W", 8453);
  assert.deepEqual(
    { symbol: fallback?.symbol, name: fallback?.name, isin: fallback?.isin, description: fallback?.description, priceUsd: fallback?.priceUsd },
    { symbol: "GOOGLc", name: "GOOGLc", isin: null, description: "", priceUsd: 301.5 },
  );
});

test("Base prices come from one batched request on chain 8453", async () => {
  const calls: string[] = [];
  const service = new StockTokenDetails("key", fakeFetch(calls, { price: () => Response.json({ [BASE_BUY_TARGETS[0]!.address.toLowerCase()]: "301.5" }) }));
  const prices = await service.prices(8453);
  assert.equal(prices.size, BASE_BUY_TARGETS.length);
  assert.equal(prices.get(BASE_BUY_TARGETS[0]!.address.toLowerCase()), 301.5);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith("https://api.1inch.com/price/v1.1/8453/"));
});

test("a Base token without a 1inch chart is charted from its most liquid GeckoTerminal pool", async () => {
  const crwv = BASE_BUY_TARGETS.find((t) => t.symbol === "CRWVc")!;
  const pool = "0x4d942b4239e0894e5a80ca2b3944e3467f4ee464";
  const now = 1_795_300_000_000;
  const hour = 3_600;
  const start = now / 1000 - 7 * 24 * hour;
  const calls: string[] = [];
  let geckoUp = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("coinbase.com")) return Response.json({ tokens: [{ contract_address: crwv.address, symbol: "CRWVc", name: "CoreWeave, Inc." }] });
    if (url.includes("/price/")) return Response.json({ [crwv.address.toLowerCase()]: "40.99" });
    if (url.includes("api.1inch.com/charts")) return Response.json({ error: "charts not supported for chosen tokens" }, { status: 400 });
    assert.equal(new Headers(init?.headers).get("authorization"), null, "the 1inch key never reaches GeckoTerminal");
    if (!geckoUp) return new Response("", { status: 429 });
    if (url.includes("/pools?")) return Response.json({ data: [{ attributes: { address: pool } }, { attributes: { address: "0x" + "1".repeat(40) } }] });
    // Newest first, with a gap where nothing traded and one candle from before the week.
    return Response.json({ data: { attributes: { ohlcv_list: [
      [start + 100 * hour, 41, 42, 40, 41.26, 10],
      [start + 2 * hour, 48, 49, 47, 48.5, 3],
      [start + 2 * hour, 48, 49, 47, 48.5, 3],
      [start - 30 * hour, 50, 51, 49, 49.25, 2],
    ] } } });
  };
  const service = new StockTokenDetails("key", fetchImpl, () => now);
  const details = await service.details(crwv.address, "1W", 8453);
  assert.equal(details?.priceUsd, 40.99);
  assert.deepEqual(details?.chart, {
    period: "1W",
    source: "geckoterminal",
    points: [{ time: start, price: 49.25 }, { time: start + 2 * hour, price: 48.5 }, { time: start + 100 * hour, price: 41.26 }],
  });
  assert.ok(calls.includes(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${crwv.address}/pools?page=1&sort=h24_volume_usd_liquidity_desc`));
  assert.ok(calls.includes(`https://api.geckoterminal.com/api/v2/networks/base/pools/${pool}/ohlcv/hour?aggregate=1&limit=500&currency=usd&token=${crwv.address}`));
  // The pool is looked up once per token; each period then costs one candle request, cached ten minutes.
  await service.details(crwv.address, "1Y", 8453);
  await service.details(crwv.address, "1W", 8453);
  assert.equal(calls.filter((url) => url.includes("/pools?")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/ohlcv/")).length, 2);
  assert.ok(calls.some((url) => url.includes("/ohlcv/day?aggregate=1&limit=365")));
  // GeckoTerminal being down or rate limited only leaves the chart empty.
  geckoUp = false;
  const fresh = await new StockTokenDetails("key", fetchImpl, () => now).details(crwv.address, "1M", 8453);
  assert.equal(fresh?.chart, null);
  assert.equal(fresh?.symbol, "CRWVc");
});

test("a 1inch chart is kept and Robinhood tokens never ask GeckoTerminal", async () => {
  const calls: string[] = [];
  const service = new StockTokenDetails("key", fakeFetch(calls, { chart: () => new Response("", { status: 400 }) }));
  assert.equal((await service.details(nvda.address, "1M"))?.chart, null);
  assert.ok(!calls.some((url) => url.includes("geckoterminal")));
});
