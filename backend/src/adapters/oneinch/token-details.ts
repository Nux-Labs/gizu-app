import { z } from "zod";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { ROBINHOOD_USDG } from "./fusion.ts";
import { ROBINHOOD_BUY_TARGETS, robinhoodBuyRank } from "./swap-targets.ts";
import { TOKEN_PROFILES, type TokenKind } from "./token-profiles.ts";

export const DETAIL_PERIODS = ["1D", "1W", "1M", "1Y"] as const;
export type DetailPeriod = (typeof DETAIL_PERIODS)[number];
const ONEINCH_PERIOD: Record<DetailPeriod, string> = { "1D": "24H", "1W": "1W", "1M": "1M", "1Y": "1Y" };

const ASSETS_TTL_MS = 10 * 60_000;
const PRICE_TTL_MS = 60_000;
const CHART_TTL_MS = 10 * 60_000;

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
const chartSchema = z.object({ data: z.array(z.object({ time: z.number().int().positive(), value: z.number().positive() })) });

type Asset = z.infer<typeof robinhoodSchema>["assets"][number];
export type TokenDetails = {
  chainId: 4663;
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  kind: TokenKind;
  description: string;
  isin: string | null;
  /** Underlying shares one token represents, as a decimal string. */
  sharesPerToken: string | null;
  sessions: { regular: boolean; extended: boolean; overnight: boolean };
  /** USD price of the token on Robinhood Chain; null when 1inch has none right now. */
  priceUsd: number | null;
  chart: { period: DetailPeriod; points: Array<{ time: number; price: number }> } | null;
};

type Cached<T> = { until: number; value: T };

const usdPrice = (raw: unknown): number | null => {
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Detail page data for a buyable Robinhood stock: Robinhood's asset record plus 1inch price and chart. */
export class RobinhoodTokenDetails {
  private assets: Cached<Map<string, Asset>> | null = null;
  private readonly priceCache = new Map<string, Cached<number | null>>();
  private priceRefresh: Promise<void> | null = null;
  private readonly charts = new Map<string, Cached<TokenDetails["chart"]>>();

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * USD prices of every buy target keyed by lowercase address, for the picker list. One batched
   * 1inch request refreshes them all and fills the cache the detail page reads.
   */
  async prices(): Promise<Map<string, number | null>> {
    const keys = ROBINHOOD_BUY_TARGETS.map((target) => target.address.toLowerCase());
    if (keys.some((key) => (this.priceCache.get(key)?.until ?? 0) <= this.now())) {
      // Concurrent list requests share one refresh instead of each calling 1inch.
      this.priceRefresh ??= this.refreshPrices(keys).finally(() => {
        this.priceRefresh = null;
      });
      await this.priceRefresh;
    }
    return new Map(keys.map((key) => [key, this.priceCache.get(key)?.value ?? null]));
  }

  private async refreshPrices(keys: string[]): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      body = (await this.oneInch(
        `https://api.1inch.com/price/v1.1/4663/${ROBINHOOD_BUY_TARGETS.map((target) => target.address).join(",")}?currency=USD`,
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

  /** Undefined for a token a buy cannot target. */
  async details(address: string, period: DetailPeriod): Promise<TokenDetails | undefined> {
    const rank = robinhoodBuyRank(address);
    const target = rank === undefined ? undefined : ROBINHOOD_BUY_TARGETS[rank];
    const profile = target && TOKEN_PROFILES[target.symbol];
    if (!target || !profile) return undefined;
    const [asset, priceUsd, chart] = await Promise.all([
      this.asset(target.address),
      this.price(target.address),
      this.chart(target.address, period),
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
  private async price(address: string): Promise<number | null> {
    return this.cached(this.priceCache, address.toLowerCase(), PRICE_TTL_MS, async () => {
      const body = await this.oneInch(`https://api.1inch.com/price/v1.1/4663/${address}?currency=USD`);
      return usdPrice((body as Record<string, unknown>)[address.toLowerCase()]);
    });
  }

  private async chart(address: string, period: DetailPeriod): Promise<TokenDetails["chart"]> {
    return this.cached(this.charts, `${address}:${period}`, CHART_TTL_MS, async () => {
      const body = chartSchema.parse(await this.oneInch(
        `https://api.1inch.com/charts/v1.0/chart/line/${address}/${ROBINHOOD_USDG}/${ONEINCH_PERIOD[period]}/4663`,
      ));
      const points = body.data.map(({ time, value }) => ({ time, price: value })).sort((a, b) => a.time - b.time);
      return points.length >= 2 ? { period, points } : null;
    });
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
}
