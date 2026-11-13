import { useContext, useEffect, useMemo, useState } from "react";
import type { CatalogToken } from "@/domain/tokenCatalog";
import type { OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { TokenCatalogContext } from "@/features/swap/useTokenCatalog";

/** Native labels a swap target it has no metadata for as `Token <last six hex digits>`. */
const PLACEHOLDER = /^Token [0-9a-f]{6}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type PortfolioTokenName = Pick<CatalogToken, "symbol" | "name" | "decimals" | "logoURI">;
export type NamedPortfolioAsset = OwnedPortfolioAsset & {
  name?: string;
  logoURI?: string | null;
};

function needsName(asset: OwnedPortfolioAsset) {
  return asset.chainId === 4663 && ADDRESS.test(asset.token) && PLACEHOLDER.test(asset.symbol);
}

/** Robinhood names its tokens "Apple • Robinhood Token"; the chain is shown elsewhere. */
function displayName(name: string) {
  return name.replace(/\s*•\s*Robinhood Token$/, "") || name;
}

/**
 * Names Robinhood Chain tokens that native portfolio only knows by address, using the public
 * token catalog. Display only: balances and values still come from native, and a token the
 * catalog cannot name keeps its native label.
 */
export function usePortfolioTokenNames<T extends OwnedPortfolioAsset>(
  assets: readonly T[],
): (T & NamedPortfolioAsset)[] {
  const service = useContext(TokenCatalogContext);
  const [names, setNames] = useState<ReadonlyMap<string, PortfolioTokenName | null>>(new Map());
  const missing = [...new Set(assets.filter(needsName).map((asset) => asset.token.toLowerCase()))]
    .filter((address) => !names.has(address))
    .sort()
    .join(",");
  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    void Promise.all(
      missing.split(",").map(async (address) => {
        try {
          const page = await service.list(
            { chainId: 4663, category: "all", search: address, page: 0 },
            controller.signal,
          );
          const token = page.list.find((row) => row.address.toLowerCase() === address);
          return [
            address,
            token
              ? {
                  symbol: token.symbol,
                  name: displayName(token.name),
                  decimals: token.decimals,
                  logoURI: token.logoURI,
                }
              : null,
          ] as const;
        } catch {
          // Unavailable catalog: keep the native label and try again on a later mount.
          return null;
        }
      }),
    ).then((rows) => {
      if (controller.signal.aborted) return;
      const found = rows.filter((row) => row !== null);
      if (found.length > 0) setNames((current) => new Map([...current, ...found]));
    });
    return () => controller.abort();
  }, [missing, service]);
  return useMemo(
    () =>
      assets.map((asset) => {
        const name = needsName(asset) ? names.get(asset.token.toLowerCase()) : undefined;
        if (!name) return asset;
        return {
          ...asset,
          symbol: name.symbol,
          name: name.name,
          logoURI: name.logoURI,
          // Native leaves an unknown token's decimals empty; the catalog supplies them for display.
          decimals: asset.decimals ?? name.decimals,
        };
      }),
    [assets, names],
  );
}
