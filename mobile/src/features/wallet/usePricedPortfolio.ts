import { useMemo } from "react";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { useOptionalMainnetWallet } from "./MainnetWalletProvider";
import { usePortfolioTokenCatalog, type PortfolioPricing } from "./usePortfolioTokenNames";

/**
 * The mainnet portfolio valued the way Home shows it: stocks a swap bought, which native knows
 * only by address, get their catalog name and market value. Decisions made from values, such as
 * strategy weights or copy amounts, read this instead of the native snapshot and wait for ready.
 */
export function usePricedPortfolio(): {
  snapshot: MainnetPortfolioSnapshot | null;
  pricing: PortfolioPricing;
} {
  const raw = useOptionalMainnetWallet()?.snapshot ?? null;
  const { assets, pricing } = usePortfolioTokenCatalog(
    raw?.ownedAssets ?? noAssets,
    raw?.checkedAt ?? 0,
  );
  const snapshot = useMemo(
    () => (raw?.ownedAssets ? { ...raw, ownedAssets: assets } : raw),
    [assets, raw],
  );
  return { snapshot, pricing };
}

const noAssets: never[] = [];
