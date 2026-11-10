import type { CatalogAsset } from "../domain/catalog.ts";

export type Opportunity = {
  id: string;
  name: string;
  symbol?: string;
  status: string;
  apr: number | null;
  totalApr: number | null;
  tvl: number | null;
  vaultAddress?: string;
  rateType?: "apr" | "apy";
  /** Explicit server-configured promotion; does not qualify native deposit support. */
  featured?: boolean;
  asset?: CatalogAsset;
  chainId: number;
  chain: {
    id: number;
    name: string;
  };
  protocol: {
    id: string;
    name: string;
  };
};

export type TvlRecord = {
  total: number;
};

export type ListOpportunitiesQuery = {
  /** Protocol id from the catalog, or "all". */
  protocol: string;
  search: string;
  page: number;
  items: number;
  chainId: number;
  /** Internal provider deadline; never part of the HTTP or cache key. */
  signal?: AbortSignal;
};

export type ProtocolFacet = {
  id: string;
  name: string;
  count: number;
};

export type OpportunityPage = {
  list: Opportunity[];
  total: number;
  partial?: boolean;
  /** Filter options present in this catalog. Counts apply search but not the protocol filter. */
  facets?: { protocols: ProtocolFacet[] };
};

export type TvlRecordsQuery = {
  id: string;
  items: number;
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
  startTimestamp: number;
  endTimestamp: number;
  creatorAddress: string;
};

export type OpportunityDetail = Opportunity & {
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

export interface Opportunities {
  list(query: ListOpportunitiesQuery): Promise<OpportunityPage>;
  getById(id: string): Promise<OpportunityDetail>;
  tvlRecords(query: TvlRecordsQuery): Promise<TvlRecord[]>;
}
