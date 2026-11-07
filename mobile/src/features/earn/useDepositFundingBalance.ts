import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { DepositFundingBalance, EarnDepositService } from "@/domain/earn/depositJourney";
import type { EarnOwner } from "@/domain/earn/types";
import { formatUsdc } from "@/domain/wallet/amounts";

/** Deposit funding is independent from the public wallet portfolio. Native rechecks at prepare. */
export function useDepositFundingBalance(
  service: EarnDepositService,
  owner: EarnOwner,
  focused: boolean,
  wallet: { balance: string | null; loading: boolean; error: boolean; refresh(): unknown },
) {
  const key = `${owner.walletId}:${owner.address ?? ""}`;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    key: string;
    generation: number;
    loading: boolean;
    error: boolean;
    publicOnly: boolean;
    snapshot: DepositFundingBalance | null;
  } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    ++sequence.current;
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        ++sequence.current;
        setState(null);
      } else if (next === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  useEffect(() => {
    const attempt = ++sequence.current;
    if (!focused || AppState.currentState === "background") return;
    let disposed = false;
    const current = () => !disposed && attempt === sequence.current;
    void Promise.resolve()
      .then(async () => {
        if (!current()) return;
        setState({
          key,
          generation,
          loading: true,
          error: false,
          publicOnly: false,
          snapshot: null,
        });
        const snapshot = await (service.fundingBalance?.(owner) ?? null);
        if (current())
          setState({
            key,
            generation,
            loading: false,
            error: snapshot !== null && !snapshot.complete,
            publicOnly: snapshot === null,
            snapshot,
          });
      })
      .catch(() => {
        if (current())
          setState({
            key,
            generation,
            loading: false,
            error: true,
            publicOnly: false,
            snapshot: null,
          });
      });
    return () => {
      disposed = true;
    };
  }, [service, owner, key, focused, generation]);
  const current = focused && state?.key === key && state.generation === generation ? state : null;
  const publicOnly = current?.publicOnly === true;
  const loading = current === null || current.loading || (publicOnly && wallet.loading);
  const error = current?.error === true || (publicOnly && wallet.error);
  const snapshot = current?.snapshot;
  return {
    balance:
      loading || error
        ? null
        : publicOnly
          ? wallet.balance
          : snapshot
            ? formatUsdc(snapshot.totalAtoms)
            : null,
    loading,
    error,
    breakdown:
      !loading && !error && snapshot
        ? {
            privateBalance: formatUsdc(snapshot.privateAtoms),
            publicBalance: formatUsdc(snapshot.publicAtoms),
          }
        : null,
    retry: () => {
      if (publicOnly) void wallet.refresh();
      refresh();
    },
  };
}
