export const tokenNetworks = [
  { chainId: 1, name: "Ethereum" },
  { chainId: 143, name: "Monad" },
  { chainId: 4663, name: "Robinhood" },
] as const;
export const TOKEN_PAGE_SIZE = 20;
export type TokenChainId = (typeof tokenNetworks)[number]["chainId"];
export type TokenCategory = "all" | CatalogToken["category"];
export interface TokenQuery {
  /** `null` browses every catalog network. */
  chainId: TokenChainId | null;
  category: TokenCategory;
  search: string;
  page: number;
  /** List only tokens a buy can target; the swap picker sets it, browsing does not. */
  liquidOnly?: boolean;
}
export interface CatalogToken {
  chainId: TokenChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
  category: "rwa" | "other";
  issuer: "Robinhood" | null;
  swapListed: boolean;
  /** `false` marks a listed stock outside the curated liquid set; older gateways omit it. */
  buyable?: boolean;
  fusionStatus: "quote-required";
}
export interface TokenPage {
  list: CatalogToken[];
  page: number;
  items: number;
  total: number;
}
export interface TokenCatalogService {
  list(query: TokenQuery, signal: AbortSignal): Promise<TokenPage>;
}
/** Robinhood names every stock "Name • Robinhood Token"; the network mark already says where it lives. */
export function tokenDisplayName(name: string): string {
  return name.replace(/\s*•\s*Robinhood Token$/, "") || name;
}
export function tokenIdentity(token: Pick<CatalogToken, "chainId" | "address">): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}
