export const tokenNetworks = [
  { chainId: 1, name: "Ethereum" },
  { chainId: 143, name: "Monad" },
  { chainId: 4663, name: "Robinhood" },
  { chainId: 8453, name: "Base" },
] as const;
/** Chains whose stock tokens a swap can buy: Robinhood Chain (USDG) and Base (USDC). */
export const swapChains = [4663, 8453] as const;
export type SwapChain = (typeof swapChains)[number];
export function isSwapChain(chainId: number): chainId is SwapChain {
  return (swapChains as readonly number[]).includes(chainId);
}
export const TOKEN_PAGE_SIZE = 20;
export type TokenChainId = (typeof tokenNetworks)[number]["chainId"];
export type TokenCategory = "all" | CatalogToken["category"];
export interface TokenQuery {
  /** `null` browses every catalog network; `chainIds` lists several in that order instead. */
  chainId: TokenChainId | null;
  chainIds?: readonly TokenChainId[];
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
  issuer: "Robinhood" | "Coinbase" | null;
  swapListed: boolean;
  /** `false` marks a listed stock outside the curated liquid set; older gateways omit it. */
  buyable?: boolean;
  /** USD price on the token's chain for buyable stocks; null when 1inch has none right now. */
  priceUsd?: number | null;
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
  /** Every swap-listed token address on one chain, lowercase; used by the swap asset sweep. */
  addresses?(chainId: TokenChainId, signal: AbortSignal): Promise<string[]>;
}
/** Robinhood names every stock "Name • Robinhood Token"; the network mark already says where it lives. */
export function tokenDisplayName(name: string): string {
  return name.replace(/\s*•\s*Robinhood Token$/, "") || name;
}
export function tokenIdentity(token: Pick<CatalogToken, "chainId" | "address">): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}
