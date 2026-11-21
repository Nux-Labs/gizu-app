import { z } from "zod";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { BASE_USDC, ROBINHOOD_USDG } from "./fusion.ts";
import { BUY_TARGETS, buyRank } from "./swap-targets.ts";
import { TOKEN_PROFILES, baseTokenProfile, type TokenKind } from "./token-profiles.ts";

export const DETAIL_PERIODS = ["1D", "1W", "1M", "1Y"] as const;
export type DetailPeriod = (typeof DETAIL_PERIODS)[number];
const ONEINCH_PERIOD: Record<DetailPeriod, string> = { "1D": "24H", "1W": "1W", "1M": "1M", "1Y": "1Y" };

const ASSETS_TTL_MS = 10 * 60_000;
const PRICE_TTL_MS = 60_000;
const CHART_TTL_MS = 10 * 60_000;
const POOL_TTL_MS = 6 * 60 * 60_000;

/**
 * GeckoTerminal candles per period. Hours without trades have no candle, so each request reaches
 * further back than the period and the series is trimmed to the period's window.
 */
const GECKO_CANDLES: Record<DetailPeriod, { timeframe: "minute" | "hour" | "day"; aggregate: number; limit: number; windowMs: number }> = {
  "1D": { timeframe: "minute", aggregate: 15, limit: 300, windowMs: 24 * 60 * 60_000 },
  "1W": { timeframe: "hour", aggregate: 1, limit: 500, windowMs: 7 * 24 * 60 * 60_000 },
  "1M": { timeframe: "hour", aggregate: 4, limit: 500, windowMs: 30 * 24 * 60 * 60_000 },
  "1Y": { timeframe: "day", aggregate: 1, limit: 365, windowMs: 365 * 24 * 60 * 60_000 },
};

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const session = z.object({ whole: z.string().optional(), fractional: z.string().optional() }).optional();
const robinhoodSchema = z.object({
  assets: z.array(z.object({
    tokenSymbol: z.string().min(1),
    tokenName: z.string().min(1),
    logoUrl: z.string().url(),
    isin: z.string().optional(),
    currentMultiplier: z.string().optional(),
    tradingCapabilities: z.object({ market: session, extended: session, overnight: session }).optional(),
    deployments: z.array(z.object({ chainId: z.number().int(), contractAddress: z.string() })),
  })),
});
// Coinbase publishes no trading sessions; its description and multiplier are optional.
const coinbaseSchema = z.object({
  tokens: z.array(z.looseObject({
    contract_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    symbol: z.string().min(1),
    name: z.string().min(1),
    icon_url: z.string().url().optional(),
    isin: z.string().optional(),
    multiplier: z.union([z.string(), z.number()]).optional(),
    description: z.string().optional(),
  })),
  next_page_token: z.string().optional(),
});
type CoinbaseAsset = z.infer<typeof coinbaseSchema>["tokens"][number];
/** The stablecoin each chain's chart is quoted against. */
const QUOTE_TOKEN: Record<StockChainId, string> = { 4663: ROBINHOOD_USDG, 8453: BASE_USDC };
export type StockChainId = 4663 | 8453;
const chartSchema = z.object({ data: z.array(z.object({ time: z.number().int().positive(), value: z.number().positive() })) });
const geckoPoolsSchema = z.object({ data: z.array(z.object({ attributes: z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }) })) });
const geckoOhlcvSchema = z.object({
  data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.array(z.number()).min(5)) }) }),
});
/** GeckoTerminal network ids for chains whose charts 1inch may not serve. */
const GECKO_NETWORK: Partial<Record<StockChainId, string>> = { 8453: "base" };

type Asset = z.infer<typeof robinhoodSchema>["assets"][number];
export type TokenDetails = {
  chainId: StockChainId;
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  kind: TokenKind;
  description: string;
  isin: string | null;
  /** Underlying shares one token represents, as a decimal string. */
  sharesPerToken: string | null;
  /** Null when the issuer publishes no trading sessions (Coinbase). */
  sessions: { regular: boolean; extended: boolean; overnight: boolean } | null;
  /** USD price of the token on its chain; null when 1inch has none right now. */
  priceUsd: number | null;
  /** `source` names the provider, for the attribution GeckoTerminal asks for. */
  chart: { period: DetailPeriod; source: "1inch" | "geckoterminal"; points: Array<{ time: number; price: number }> } | null;
};

type Cached<T> = { until: number; value: T };

const usdPrice = (raw: unknown): number | null => {
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * Detail page data for a buyable stock token: the issuer's record (Robinhood, or Coinbase on Base)
 * plus 1inch price and chart on the token's chain. Most Coinbase tokens have no 1inch chart, so Base
 * charts fall back to GeckoTerminal candles from the token's most liquid pool.
 */
export class StockTokenDetails {
  private assets: Cached<Map<string, Asset>> | null = null;
  /** Last good Coinbase list; a failed refresh keeps serving it. */
  private coinbaseAssets: Cached<Map<string, CoinbaseAsset>> | null = null;
  private readonly priceCache = new Map<string, Cached<number | null>>();
  private readonly priceRefresh = new Map<StockChainId, Promise<void>>();
  private readonly charts = new Map<string, Cached<TokenDetails["chart"]>>();
  private readonly geckoPools = new Map<string, Cached<string | null>>();

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * USD prices of every buy target keyed by lowercase address, for the picker list. One batched
   * 1inch request refreshes them all and fills the cache the detail page reads.
   */
  async prices(chainId: StockChainId = 4663): Promise<Map<string, number | null>> {
    const keys = BUY_TARGETS[chainId].map((target) => target.address.toLowerCase());
    if (keys.some((key) => (this.priceCache.get(key)?.until ?? 0) <= this.now())) {
      // Concurrent list requests share one refresh per chain instead of each calling 1inch.
      let refresh = this.priceRefresh.get(chainId);
      if (!refresh) {
        refresh = this.refreshPrices(chainId, keys).finally(() => this.priceRefresh.delete(chainId));
        this.priceRefresh.set(chainId, refresh);
      }
      await refresh;
    }
    return new Map(keys.map((key) => [key, this.priceCache.get(key)?.value ?? null]));
  }

  private async refreshPrices(chainId: StockChainId, keys: string[]): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      body = (await this.oneInch(
        `https://api.1inch.com/price/v1.1/${chainId}/${BUY_TARGETS[chainId].map((target) => target.address).join(",")}?currency=USD`,
      )) as Record<string, unknown>;
    } catch {
      // Every price stays null for a minute; the list still loads without them.
    }
    const at = this.now();
    for (const key of keys) {
      const value = usdPrice(body[key]);
      this.priceCache.set(key, { until: at + (value === null ? 60_000 : PRICE_TTL_MS), value });
    }
  }

  /** Undefined for a token a buy cannot target on that chain. */
  async details(address: string, period: DetailPeriod, chainId: StockChainId = 4663): Promise<TokenDetails | undefined> {
    const rank = buyRank(chainId, address);
    const target = rank === undefined ? undefined : BUY_TARGETS[chainId][rank];
    if (!target) return undefined;
    if (chainId === 8453) return this.baseDetails(target.address, period, target.symbol);
    const profile = TOKEN_PROFILES[target.symbol];
    if (!profile) return undefined;
    const [asset, priceUsd, chart] = await Promise.all([
      this.asset(target.address),
      this.price(4663, target.address),
      this.chart(4663, target.address, period),
    ]);
    const tradable = (s: z.infer<typeof session>) =>
      s?.whole === "TRADING_STATUS_TRADABLE" || s?.fractional === "TRADING_STATUS_TRADABLE";
    const multiplier = asset.currentMultiplier;
    return {
      chainId: 4663,
      address: target.address,
      symbol: asset.tokenSymbol,
      name: asset.tokenName,
      logoURI: asset.logoUrl,
      kind: profile.kind,
      description: profile.description,
      isin: asset.isin?.trim() || null,
      sharesPerToken: multiplier && decimal.safeParse(multiplier).success ? multiplier : null,
      sessions: {
        regular: tradable(asset.tradingCapabilities?.market),
        extended: tradable(asset.tradingCapabilities?.extended),
        overnight: tradable(asset.tradingCapabilities?.overnight),
      },
      priceUsd,
      chart,
    };
  }

  private async baseDetails(address: string, period: DetailPeriod, symbol: string): Promise<TokenDetails> {
    const [asset, priceUsd, chart] = await Promise.all([
      // Without Coinbase the page still shows the pinned symbol with its 1inch price and chart.
      this.coinbaseAsset(address).catch((): CoinbaseAsset => ({ contract_address: address, symbol, name: symbol })),
      this.price(8453, address),
      this.chart(8453, address, period),
    ]);
    const multiplier = asset.multiplier === undefined ? undefined : String(asset.multiplier);
    // Our own copy matches the Robinhood pages; Coinbase's text covers a token without one.
    const profile = baseTokenProfile(symbol);
    return {
      chainId: 8453,
      address,
      symbol: asset.symbol,
      name: asset.name,
      logoURI: asset.icon_url ?? "",
      kind: profile?.kind ?? "stock",
      description: profile?.description ?? asset.description?.trim() ?? "",
      isin: asset.isin?.trim() || null,
      sharesPerToken: multiplier && decimal.safeParse(multiplier).success ? multiplier : null,
      sessions: null,
      priceUsd,
      chart,
    };
  }

  private async coinbaseAsset(address: string): Promise<CoinbaseAsset> {
    if (!this.coinbaseAssets || this.coinbaseAssets.until <= this.now()) {
      try {
        const byAddress = new Map<string, CoinbaseAsset>();
        let pageToken: string | undefined;
        for (let page = 0; page < 4; page++) {
          const url = new URL("https://api.coinbase.com/v1/tokenized-stocks");
          url.searchParams.set("page_size", "500");
          if (pageToken) url.searchParams.set("page_token", pageToken);
          const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`Coinbase tokenized stocks unavailable (${response.status})`);
          const parsed = coinbaseSchema.parse(await response.json());
          for (const token of parsed.tokens) byAddress.set(token.contract_address.toLowerCase(), token);
          pageToken = parsed.next_page_token;
          if (!pageToken) break;
        }
        this.coinbaseAssets = { until: this.now() + ASSETS_TTL_MS, value: byAddress };
      } catch (error) {
        // A stale list still names the token; only a first failure fails the page.
        if (!this.coinbaseAssets) {
          throw new InfrastructureError(503, "TOKEN_DETAILS_UNAVAILABLE", "token details unavailable", { cause: error });
        }
      }
    }
    const asset = this.coinbaseAssets.value.get(address.toLowerCase());
    if (!asset) throw new InfrastructureError(503, "TOKEN_DETAILS_UNAVAILABLE", "Coinbase no longer lists this token");
    return asset;
  }

  private async asset(address: string): Promise<Asset> {
    if (!this.assets || this.assets.until <= this.now()) {
      try {
        const response = await this.fetchImpl("https://api.robinhood.com/rhj/assets", { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Robinhood asset catalog unavailable (${response.status})`);
        const parsed = robinhoodSchema.parse(await response.json());
        const byAddress = new Map<string, Asset>();
        for (const asset of parsed.assets) {
          for (const deployment of asset.deployments) {
            if (deployment.chainId === 4663) byAddress.set(deployment.contractAddress.toLowerCase(), asset);
          }
        }
        this.assets = { until: this.now() + ASSETS_TTL_MS, value: byAddress };
      } catch (error) {
        throw new InfrastructureError(503, "TOKEN_DETAILS_UNAVAILABLE", "token details unavailable", { cause: error });
      }
    }
    const asset = this.assets.value.get(address.toLowerCase());
    if (!asset) throw new InfrastructureError(503, "TOKEN_DETAILS_UNAVAILABLE", "Robinhood no longer lists this token");
    return asset;
  }

  // Price and chart are optional on the page: a failure is cached briefly as null instead of failing it.
  private async price(chainId: StockChainId, address: string): Promise<number | null> {
    return this.cached(this.priceCache, address.toLowerCase(), PRICE_TTL_MS, async () => {
      const body = await this.oneInch(`https://api.1inch.com/price/v1.1/${chainId}/${address}?currency=USD`);
      return usdPrice((body as Record<string, unknown>)[address.toLowerCase()]);
    });
  }

  private async chart(chainId: StockChainId, address: string, period: DetailPeriod): Promise<TokenDetails["chart"]> {
    return this.cached(this.charts, `${chainId}:${address}:${period}`, CHART_TTL_MS, async () => {
      const oneInch = await this.oneInchChart(chainId, address, period).catch(() => null);
      if (oneInch) return oneInch;
      const network = GECKO_NETWORK[chainId];
      return network ? this.geckoChart(network, address, period) : null;
    });
  }

  private async oneInchChart(chainId: StockChainId, address: string, period: DetailPeriod): Promise<TokenDetails["chart"]> {
    const body = chartSchema.parse(await this.oneInch(
      `https://api.1inch.com/charts/v1.0/chart/line/${address}/${QUOTE_TOKEN[chainId]}/${ONEINCH_PERIOD[period]}/${chainId}`,
    ));
    const points = body.data.map(({ time, value }) => ({ time, price: value })).sort((a, b) => a.time - b.time);
    return points.length >= 2 ? { period, source: "1inch", points } : null;
  }

  /** USD closes of the token in its most liquid pool, oldest first, trimmed to the period. */
  private async geckoChart(network: string, address: string, period: DetailPeriod): Promise<TokenDetails["chart"]> {
    const pool = await this.cached(this.geckoPools, `${network}:${address.toLowerCase()}`, POOL_TTL_MS, async () => {
      const body = geckoPoolsSchema.parse(await this.gecko(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1&sort=h24_volume_usd_liquidity_desc`,
      ));
      return body.data[0]?.attributes.address ?? null;
    });
    if (!pool) return null;
    const { timeframe, aggregate, limit, windowMs } = GECKO_CANDLES[period];
    const body = geckoOhlcvSchema.parse(await this.gecko(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd&token=${address}`,
    ));
    const candles = body.data.attributes.ohlcv_list
      .map(([time, , , , close]) => ({ time: time!, price: close! }))
      .filter(({ time, price }) => Number.isSafeInteger(time) && time > 0 && Number.isFinite(price) && price > 0)
      .sort((a, b) => a.time - b.time)
      .filter((point, index, all) => index === 0 || point.time > all[index - 1]!.time);
    const start = Math.floor((this.now() - windowMs) / 1000);
    const inside = candles.filter(({ time }) => time >= start);
    // Without trades the price holds, so the last close before the window opens the line at its start.
    const before = candles.findLast(({ time }) => time < start);
    const points = before && inside[0]?.time !== start ? [{ time: start, price: before.price }, ...inside] : inside;
    return points.length >= 2 ? { period, source: "geckoterminal", points } : null;
  }

  private async cached<T>(cache: Map<string, Cached<T | null>>, key: string, ttl: number, load: () => Promise<T | null>): Promise<T | null> {
    const hit = cache.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    let value: T | null;
    try {
      value = await load();
    } catch {
      value = null;
    }
    // A miss is retried after a minute rather than the full lifetime.
    cache.set(key, { until: this.now() + (value === null ? Math.min(ttl, 60_000) : ttl), value });
    return value;
  }

  private async oneInch(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`1inch data unavailable (${response.status})`);
    return response.json();
  }

  // Keyless public API (30 calls a minute); charts and pools are cached so pages stay well below it.
  private async gecko(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json;version=20230203" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GeckoTerminal data unavailable (${response.status})`);
    return response.json();
  }
}
