import { useCallback, useContext, useEffect, useState } from "react";
import type {
  CatalogChain,
  Opportunity,
  OpportunityQuery,
  ProtocolFacet,
} from "@/domain/opportunities";
import { useInfiniteList } from "@/hooks/useInfiniteList";
import { OpportunityServiceContext } from "./useOpportunities";
import { catalogCursor, readCatalogPage } from "./catalogPages";
export const opportunityIdentity = (item: Opportunity) => item.id;
export function useInfiniteOpportunities() {
  const service = useContext(OpportunityServiceContext);
  const [query, setQuery] = useState<Omit<OpportunityQuery, "page">>({ search: "" });
  const [debounceMs, setDebounceMs] = useState(0);
  const [chains, setChains] = useState<CatalogChain[]>([]);
  const [chainStatus, setChainStatus] = useState<"loading" | "ready" | "failed">(
    service.chains ? "loading" : "ready",
  );
  const [chainRevision, setChainRevision] = useState(0);
  const [partial, setPartial] = useState(false);
  // Kept across query changes so filter options don't flicker while the next page loads.
  const [protocols, setProtocols] = useState<ProtocolFacet[]>([]);
  useEffect(() => {
    if (!service.chains) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChainStatus("loading");
    void service.chains(controller.signal).then(
      (rows) => {
        if (controller.signal.aborted) return;
        setChains(rows);
        setChainStatus("ready");
      },
      () => {
        if (!controller.signal.aborted) setChainStatus("failed");
      },
    );
    return () => controller.abort();
  }, [service, chainRevision]);
  const queryKey = JSON.stringify(query);
  const initialCursor = catalogCursor(service.chains ? chains : undefined);
  const loadPage = useCallback(
    async (cursor: string, signal: AbortSignal) => {
      const data = await readCatalogPage(service, query, cursor, signal);
      if (!signal.aborted) {
        setPartial((previous) => data.partial || (cursor !== initialCursor && previous));
        // The first page reads every chain, so it carries the complete option set.
        if (cursor === initialCursor) setProtocols(data.facets);
      }
      return data;
    },
    [query, service, initialCursor],
  );
  const list = useInfiniteList({
    queryKey,
    initialCursor,
    loadPage,
    getIdentity: opportunityIdentity,
    debounceMs,
    enabled: chainStatus === "ready",
  });
  function change(next: typeof query) {
    list.invalidate();
    setDebounceMs(next.search !== query.search ? 300 : 0);
    setQuery(next);
    setPartial(false);
  }
  return {
    query,
    queryKey,
    partial,
    protocols,
    list: {
      ...list,
      loading: chainStatus === "loading" || (chainStatus === "ready" && list.loading),
      error: chainStatus === "failed" ? ("initial" as const) : list.error,
      retry: chainStatus === "failed" ? () => setChainRevision((value) => value + 1) : list.retry,
    },
    change,
  };
}
