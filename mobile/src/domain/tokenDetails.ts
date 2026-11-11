export const detailPeriods = ["1D", "1W", "1M", "1Y"] as const;
export type DetailPeriod = (typeof detailPeriods)[number];

/** Detail page data for a swappable Robinhood stock or fund, from `GET /v1/tokens/4663/:address/details`. */
export interface TokenDetails {
  chainId: 4663;
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  kind: "stock" | "fund";
  description: string;
  isin: string | null;
  /** Underlying shares one token represents, as a decimal string. */
  sharesPerToken: string | null;
  sessions: { regular: boolean; extended: boolean; overnight: boolean };
  /** USD price of the token on Robinhood Chain, not the exchange price. */
  priceUsd: number | null;
  chart: { period: DetailPeriod; points: { time: number; price: number }[] } | null;
}

export interface TokenDetailsService {
  details(address: string, period: DetailPeriod, signal: AbortSignal): Promise<TokenDetails>;
}

/** Percentage change across the chart, or null without two usable points. */
export function periodChange(details: Pick<TokenDetails, "chart">): number | null {
  const points = details.chart?.points;
  const first = points?.[0]?.price;
  const last = points?.[points.length - 1]?.price;
  if (first === undefined || last === undefined || first <= 0) return null;
  return ((last - first) / first) * 100;
}

/** Trading sessions in display order, by the names Robinhood customers know. */
export function sessionNames(sessions: TokenDetails["sessions"]): string[] {
  return [
    sessions.regular && "Regular hours",
    sessions.extended && "Extended hours",
    sessions.overnight && "24 Hour Market",
  ].filter((name): name is string => name !== false);
}
