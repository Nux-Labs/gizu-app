import { createContext, useContext, useEffect, useState } from "react";
import type { DetailPeriod, TokenDetails, TokenDetailsService } from "@/domain/tokenDetails";
import { tokenDetailsService } from "@/services/tokenDetails";

export const TokenDetailsContext = createContext<TokenDetailsService>(tokenDetailsService);

export type TokenDetailsLoad = {
  /** Last loaded details for this token; kept while another period loads so the page does not blank out. */
  details: TokenDetails | null;
  status: "loading" | "ready" | "failed";
  retry: () => void;
};

type Settled = { key: string; details: TokenDetails | null; failed: boolean };

/** Loads one token's detail page for a period; stale responses are dropped after a change. */
export function useTokenDetails(address: string, period: DetailPeriod): TokenDetailsLoad {
  const service = useContext(TokenDetailsContext);
  const [attempt, setAttempt] = useState(0);
  const key = `${address.toLowerCase()}:${period}:${attempt}`;
  const [settled, setSettled] = useState<Settled>({ key: "", details: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    service.details(address, period, controller.signal).then(
      (details) => {
        if (!controller.signal.aborted) setSettled({ key, details, failed: false });
      },
      () => {
        if (!controller.signal.aborted)
          setSettled((current) => ({ key, details: current.details, failed: true }));
      },
    );
    return () => controller.abort();
  }, [service, address, period, key]);
  // Only this token's earlier details may stay on screen while the next request runs.
  const details =
    settled.details?.address.toLowerCase() === address.toLowerCase() ? settled.details : null;
  const status = settled.key !== key ? "loading" : settled.failed ? "failed" : "ready";
  return { details, status, retry: () => setAttempt((value) => value + 1) };
}
