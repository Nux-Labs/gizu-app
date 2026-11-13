import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { tokenNetworks, type CatalogToken, type TokenChainId } from "@/domain/tokenCatalog";
import type { OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { portfolioAssetAmount } from "@/domain/wallet/portfolioValue";
import { TokenCatalogContext } from "@/features/swap/useTokenCatalog";

/** Native labels a swap target it has no metadata for as `Token <last six hex digits>`. */
const PLACEHOLDER = /^Token [0-9a-f]{6}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Market prices are refreshed with the balance, at most this often. */
export const PRICE_TTL_MS = 5 * 60_000;

export type PortfolioTokenName = Pick<CatalogToken, "symbol" | "name" | "decimals" | "logoURI">;
export type NamedPortfolioAsset = OwnedPortfolioAsset & {
  name?: string;
  logoURI?: string | null;
  /** Catalogue market price used for the display value; native never priced this token. */
  priceUsd?: number;
  /** A swap ledger token native knew only by address, such as a stock a swap bought. */
  fromSwap?: boolean;
};
type Entry = { token: PortfolioTokenName | null; priceUsd: number | null; fetchedAt: number };

function catalogChain(chainId: number): chainId is TokenChainId {
  return tokenNetworks.some((network) => network.chainId === chainId);
}

function needsName(asset: OwnedPortfolioAsset) {
  return catalogChain(asset.chainId) && ADDRESS.test(asset.token) && PLACEHOLDER.test(asset.symbol);
}

/** Swap ledger assets can live on any catalogue chain, so names are keyed by chain and token. */
const nameKey = (asset: Pick<OwnedPortfolioAsset, "chainId" | "token">) =>
  `${asset.chainId}:${asset.token.toLowerCase()}`;

/** Robinhood names its tokens "Apple • Robinhood Token"; the chain is shown elsewhere. */
function displayName(name: string) {
  return name.replace(/\s*•\s*Robinhood Token$/, "") || name;
}

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1e9;
}

/** USD value in 6-decimal atoms, rounded down: balance × price, at the token's precision. */
export function marketValueAtoms(atoms: string, decimals: number, priceUsd: number): string {
  const price = BigInt(Math.round(priceUsd * 1e6));
  return ((BigInt(atoms) * price) / 10n ** BigInt(decimals)).toString();
}

/**
 * Names and prices swap ledger tokens that native portfolio only knows by address, using the
 * public token catalog. Display only: balances still come from native, a token the catalog cannot
 * name keeps its native label, and a token without a market price keeps no USD value. Prices are
 * refetched when [refreshKey] changes and the last fetch is older than [PRICE_TTL_MS].
 */
export function usePortfolioTokenNames<T extends OwnedPortfolioAsset>(
  assets: readonly T[],
  refreshKey = 0,
): (T & NamedPortfolioAsset)[] {
  const service = useContext(TokenCatalogContext);
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const latest = useRef(entries);
  useEffect(() => {
    latest.current = entries;
  }, [entries]);
  const needed = [...new Set(assets.filter(needsName).map(nameKey))].sort().join(",");
  useEffect(() => {
    if (!needed) return;
    const now = Date.now();
    const due = needed.split(",").filter((key) => {
      const entry = latest.current.get(key);
      return !entry || now - entry.fetchedAt >= PRICE_TTL_MS;
    });
    if (due.length === 0) return;
    const controller = new AbortController();
    void Promise.all(
      due.map(async (key) => {
        const [chain, address] = key.split(":") as [string, string];
        const chainId = Number(chain);
        if (!catalogChain(chainId)) return null;
        try {
          const page = await service.list(
            { chainId, category: "all", search: address, page: 0 },
            controller.signal,
          );
          const token = page.list.find((row) => row.address.toLowerCase() === address);
          const entry: Entry = {
            token: token
              ? {
                  symbol: token.symbol,
                  name: displayName(token.name),
                  decimals: token.decimals,
                  logoURI: token.logoURI,
                }
              : null,
            priceUsd: token && validPrice(token.priceUsd) ? token.priceUsd : null,
            fetchedAt: now,
          };
          return [key, entry] as const;
        } catch {
          // Unavailable catalog: keep the last name and price, and retry on a later refresh.
          return null;
        }
      }),
    ).then((rows) => {
      if (controller.signal.aborted) return;
      const found = rows.filter((row) => row !== null);
      if (found.length > 0) setEntries((current) => new Map([...current, ...found]));
    });
    return () => controller.abort();
  }, [needed, refreshKey, service]);
  return useMemo(
    () =>
      assets.map((asset) => {
        if (!needsName(asset)) return asset;
        const entry = entries.get(nameKey(asset));
        if (!entry?.token) return { ...asset, fromSwap: true };
        // Native leaves an unknown token's decimals empty; the catalog supplies them for display.
        const decimals = asset.decimals ?? entry.token.decimals;
        const atoms = portfolioAssetAmount(asset);
        const priced =
          entry.priceUsd !== null &&
          atoms !== null &&
          asset.valueUsdcAtoms === null &&
          asset.valueUsdAtoms == null;
        return {
          ...asset,
          fromSwap: true,
          symbol: entry.token.symbol,
          name: entry.token.name,
          logoURI: entry.token.logoURI,
          decimals,
          ...(priced
            ? {
                priceUsd: entry.priceUsd!,
                valueUsdAtoms: marketValueAtoms(atoms, decimals, entry.priceUsd!),
              }
            : {}),
        };
      }),
    [assets, entries],
  );
}
