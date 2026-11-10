export type Opportunity = {
  id: string;
  name: string;
  symbol?: string;
  chainId: number;
  vaultAddress?: string;
  /** Verified deposit underlying; receipt and reward tokens are separate. */
  asset?: { address: string; name: string; symbol: string; decimals: number };
  rateType?: "apr" | "apy";
  /** Server-configured promotion, independent from native signing/deposit eligibility. */
  featured?: boolean;
  protocol: { id: string; name: string };
  status: string;
  totalApr: number | null;
  tvl: number | null;
};
export type CatalogChain = { id: number; name: string; explorerUrl?: string };
/** A protocol present in the catalog; filter options come from the backend, never a fixed list. */
export type ProtocolFacet = { id: string; name: string; count: number };
export type OpportunityQuery = {
  search: string;
  /** Catalog protocol id; omitted means every protocol. */
  protocol?: string;
  page: number;
  chainId?: number;
};
export type OpportunityPage = {
  list: Opportunity[];
  total: number;
  page: number;
  items: number;
  partial?: boolean;
  /** Counts apply the search but not the protocol filter, so options stay visible once one is chosen. */
  facets?: { protocols: ProtocolFacet[] };
};
export type OpportunityToken = {
  id: string;
  name: string;
  symbol: string;
  address: string;
  decimals: number;
  price: number | null;
};
export type OpportunityCampaign = {
  id: string;
  campaignId: string;
  type: string;
  apr: number;
  dailyRewards: number;
  /** Unix seconds. */
  startTimestamp: number;
  /** Unix seconds. */
  endTimestamp: number;
  creatorAddress: string;
};
/** Backend `GET /v1/opportunities/:id` → `{ opportunity }`. */
export type OpportunityDetail = Opportunity & {
  apr: number | null;
  chain: { name: string };
  description: string;
  action: string;
  type: string;
  dailyRewards: number | null;
  liveCampaigns: number;
  nativeApr: number | null;
  explorerAddress: string;
  howToSteps: string[];
  depositUrl: string;
  identifier: string;
  tags: string[];
  tokens: OpportunityToken[];
  campaigns: OpportunityCampaign[];
};
/** Backend `GET /v1/opportunities/:id/tvl-records` row, newest first. */
export type TvlRecord = { total: number };
export interface OpportunityService {
  /** Optional for older injected adapters; production loads the backend chain catalog. */
  chains?(signal: AbortSignal): Promise<CatalogChain[]>;
  list(query: OpportunityQuery, signal: AbortSignal): Promise<OpportunityPage>;
  detail(id: string, signal: AbortSignal): Promise<OpportunityDetail>;
  tvlRecords(id: string, signal: AbortSignal): Promise<TvlRecord[]>;
}

/** TVL records arrive newest first; charts plot oldest → newest (frontend reverses). */
export function tvlSeries(records: TvlRecord[]): number[] {
  return records.map((row) => row.total).reverse();
}

/** Frontend card change: last sample vs the one before, in percent; null when undefined. */
export function tvlChange(series: number[]): number | null {
  const previous = series[series.length - 2];
  const latest = series[series.length - 1];
  if (previous === undefined || latest === undefined || previous === 0) return null;
  return ((latest - previous) / previous) * 100;
}

/** Only plain https deposit pages are offered as external links. */
export function safeExternalUrl(url: string): string | null {
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}
