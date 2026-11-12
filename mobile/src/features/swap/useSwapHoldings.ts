import { useCallback, useEffect, useRef, useState } from "react";
import type { SwapHoldingsSnapshot } from "@/domain/wallet/storedSigner";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { swapGateway, swapSigner } from "./confidentialSwap";

/** Public balances only. Native storage owns discovery and native review owns every sale. */
export function useSwapHoldings(onSaleSettled?: () => void) {
  const mainnet = useOptionalMainnetWallet();
  const [snapshot, setSnapshot] = useState<SwapHoldingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"" | "holdings">("");
  const [saleFailed, setSaleFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await swapSigner().getSwapHoldings("");
      if (alive.current) setSnapshot(next);
    } catch {
      if (alive.current) setError("holdings");
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void refresh();
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);

  const sell = async (id: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setSaleFailed(false);
    setNotice("");
    try {
      const status = await swapSigner().sellSwapHolding(id, swapGateway);
      if (alive.current)
        setNotice(
          status.phase === "COMPLETE"
            ? status.completionTarget === "confidential"
              ? "Swap completed. Verified USDC proceeds remain in your confidential balance."
              : "Swap completed. Proceeds returned to the new wallets shown in Swap."
            : "Swap is not complete. Open Swap to review or resume it.",
        );
    } catch {
      if (alive.current) setSaleFailed(true);
    } finally {
      running.current = false;
      if (alive.current) {
        setBusy(false);
        void refresh();
        if (mainnet) void mainnet.refreshAfterAction();
      }
      onSaleSettled?.();
    }
  };

  return {
    snapshot,
    busy,
    error,
    saleFailed,
    retryRead: refresh,
    notice,
    sell,
  };
}
