import { useEffect, useState } from "react";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { appendBalancePoint, type BalancePoint } from "@/domain/wallet/balanceHistory";
import { balanceHistoryStore } from "@/storage/balanceHistory";

/** Loads this wallet's observed balances and records each complete, fresh snapshot. */
export function useBalanceHistory(
  snapshot: MainnetPortfolioSnapshot | null,
  valuation?: { totalAtoms: string; complete: boolean; checkedAt: number },
) {
  const walletId = snapshot?.walletId;
  const [state, setState] = useState<{ walletId?: string; history: BalancePoint[] }>({
    history: [],
  });
  const historyKey = walletId
    ? valuation
      ? `${walletId}:portfolio-value-v1`
      : walletId
    : undefined;
  const fresh =
    snapshot &&
    snapshot.balanceComplete !== false &&
    !snapshot.stale &&
    (!valuation || valuation.complete);
  const at = fresh ? (valuation?.checkedAt ?? snapshot.checkedAt) : undefined;
  const atoms = fresh ? (valuation?.totalAtoms ?? snapshot.totalAtoms) : undefined;
  useEffect(() => {
    if (!walletId || !historyKey) return;
    let active = true;
    void balanceHistoryStore.load(historyKey).then((loaded) => {
      if (!active) return;
      const next =
        at !== undefined && atoms !== undefined
          ? appendBalancePoint(loaded, { at, atoms })
          : loaded;
      setState({ walletId, history: next });
      if (next !== loaded) void balanceHistoryStore.save(historyKey, next).catch(() => undefined);
    });
    return () => {
      active = false;
    };
  }, [walletId, historyKey, at, atoms]);
  return state.walletId === walletId ? state.history : [];
}
