import { z } from "zod";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { robinhoodBuyRank } from "./swap-targets.ts";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const tokenSchema = z.object({
  address: addressSchema,
  symbol: z.string().min(1),
  name: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  logoURI: z.string().nullable(),
  tags: z.array(z.string()),
});
const oneInchSchema = z.object({ tokens: z.record(z.string(), tokenSchema) });
const robinhoodSchema = z.object({
  assets: z.array(z.object({
    tokenSymbol: z.string().min(1),
    tokenName: z.string().min(1),
    tokenDecimals: z.number().int().nonnegative(),
    status: z.enum(["ASSET_STATUS_UNSPECIFIED", "ASSET_STATUS_ACTIVE", "ASSET_STATUS_INACTIVE"]),
    logoUrl: z.string().url(),
    deployments: z.array(z.object({ chainId: z.number().int().positive(), contractAddress: addressSchema })),
  })),
});
const CACHE_TTL_MS = 10 * 60_000;

export type CatalogToken = {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
  category: "rwa" | "other";
  issuer: "Robinhood" | null;
  swapListed: boolean;
  /** Only the curated deep-liquidity Robinhood stocks can start a buy; the native engine enforces the same list. */
  buyable: boolean;
  fusionStatus: "quote-required";
};

export type CatalogCategory = "all" | CatalogToken["category"];

export class OneInchTokenCatalog {
  private readonly cache = new Map<number, { until: number; tokens: CatalogToken[] }>();

  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(chainId: number, category: CatalogCategory): Promise<CatalogToken[]> {
    const cached = this.cache.get(chainId);
    let tokens: CatalogToken[];
    if (cached && cached.until > Date.now()) {
      tokens = cached.tokens;
    } else {
      try {
        tokens = await this.load(chainId);
      } catch (error) {
        throw new InfrastructureError(503, "TOKEN_CATALOG_UNAVAILABLE", "token catalog unavailable", { cause: error });
      }
      this.cache.set(chainId, { until: Date.now() + CACHE_TTL_MS, tokens });
    }
    return category === "all" ? tokens : tokens.filter((token) => token.category === category);
  }

  private async load(chainId: number): Promise<CatalogToken[]> {
    if (![1, 143, 4663].includes(chainId)) throw new Error("Unsupported chain");
    const response = await this.fetchImpl(`https://api.1inch.com/swap/v6.1/${chainId}/tokens`, {
      headers: { Authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`1inch token catalog unavailable (${response.status})`);
    const parsed = oneInchSchema.parse(await response.json());
    const listed = new Map<string, CatalogToken>();
    for (const [address, token] of Object.entries(parsed.tokens)) {
      if (address.toLowerCase() !== token.address.toLowerCase()) {
        throw new Error("1inch token address does not match its map key");
      }
      listed.set(token.address.toLowerCase(), {
        chainId,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        logoURI: token.logoURI,
        category: token.tags.some((tag) => tag.toLowerCase() === "rwa") ? "rwa" : "other",
        issuer: null,
        swapListed: true,
        buyable: false,
        fusionStatus: "quote-required",
      });
    }
    if (chainId === 4663) {
      const robinhoodResponse = await this.fetchImpl("https://api.robinhood.com/rhj/assets", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!robinhoodResponse.ok) throw new Error(`Robinhood asset catalog unavailable (${robinhoodResponse.status})`);
      const robinhood = robinhoodSchema.parse(await robinhoodResponse.json());
      for (const asset of robinhood.assets) {
        if (asset.status !== "ASSET_STATUS_ACTIVE") continue;
        for (const deployment of asset.deployments) {
          if (deployment.chainId !== 4663) continue;
          const address = deployment.contractAddress.toLowerCase();
          const found = listed.get(address);
          const foundDecimals = found?.decimals;
          if (foundDecimals !== undefined && foundDecimals !== asset.tokenDecimals) {
            throw new Error("Robinhood and 1inch token decimals disagree");
          }
          listed.set(address, {
            chainId,
            address: deployment.contractAddress,
            symbol: asset.tokenSymbol,
            name: asset.tokenName,
            decimals: asset.tokenDecimals,
            logoURI: asset.logoUrl,
            category: "rwa",
            issuer: "Robinhood",
            swapListed: found !== undefined,
            buyable: found !== undefined && robinhoodBuyRank(address) !== undefined,
            fusionStatus: "quote-required",
          });
        }
      }
    }
    // Buyable stocks lead in liquidity order so the picker opens on what a buy can actually use.
    const rank = (token: CatalogToken) => (token.buyable ? robinhoodBuyRank(token.address) ?? Infinity : Infinity);
    return [...listed.values()].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
  }
}
