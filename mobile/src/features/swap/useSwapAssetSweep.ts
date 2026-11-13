import { useContext, useEffect, useRef } from "react";
import type { TokenChainId } from "@/domain/tokenCatalog";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";
import { TokenCatalogContext } from "./useTokenCatalog";

/** Chains swaps can deliver to. Native keeps its own matching list and rejects any other chain. */
export const SWAP_SWEEP_CHAINS: readonly TokenChainId[] = [4663];

/**
 * Recovery sweep for the swap asset ledger, run once per mount after the first balance read.
 * Native decides whether a chain is due (after a restore, then daily) and only reads balances;
 * when it finds a held token that was not tracked, [onFound] refreshes the portfolio.
 * Background work: a failure is silent and the next mount tries again.
 */
export function useSwapAssetSweep(enabled: boolean, onFound: () => void) {
  const service = useContext(TokenCatalogContext);
  const started = useRef(false);
  const found = useRef(onFound);
  useEffect(() => {
    found.current = onFound;
  }, [onFound]);
  useEffect(() => {
    if (!enabled || started.current) return;
    const signer = getStoredSwapSigner();
    const sweep = signer?.sweepSwapAssets;
    const addresses = service.addresses;
    if (!sweep || !addresses) return;
    started.current = true;
    const controller = new AbortController();
    void (async () => {
      let added = false;
      for (const chainId of SWAP_SWEEP_CHAINS) {
        try {
          const tokens = await addresses.call(service, chainId, controller.signal);
          if (controller.signal.aborted) return;
          const result = await sweep.call(signer, chainId, tokens);
          if (result.added.length > 0) added = true;
        } catch {
          // Catalogue or RPC unavailable: the ledger is unchanged and a later mount retries.
        }
      }
      if (added && !controller.signal.aborted) found.current();
    })();
    return () => {
      controller.abort();
      started.current = false;
    };
  }, [enabled, service]);
}
