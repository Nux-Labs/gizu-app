# Infinite lists

Source reviewed 2026-11-14. Swap token discovery/pickers and mainnet Vaults share
`src/hooks/useInfiniteList.ts` and `src/components/templates/InfiniteListScreen.tsx`. Home
previews retain their existing bounded pagination. Backend contracts are unchanged.

## Adding a feature

1. Keep query/filter state and response validation in the feature/service adapter.
   Memoize a loader `(cursor, signal) => Promise<{ items, nextCursor }>` and provide
   a stable item identity function. Cursors are strings or numbers; `null` ends a
   list. Derive numeric continuation from the response page, page size and total,
   not the number of unique items already rendered.
2. Call the hook with a stable string `queryKey`, `initialCursor`, `loadPage`, and
   `getIdentity`. The key must include all filters and account identity when relevant.
   Loader identity changes also reset the list. Do not pass inline loader/identity
   functions that change on every render.
3. Before updating query state, call `invalidate()` to synchronously abort and
   clear previous results. Pass `debounceMs: 300` for search changes and zero for
   other filter changes. Resetting query keys scrolls to the top without remounting
   the list header or search input.
4. Pass the returned list state to `InfiniteListScreen`, with feature copy, header,
   identity and item renderer. It owns the only vertical scroll container. Do not
   wrap it in `Screen` or another `ScrollView`.

Layouts are `list`, `grid` (two columns) and `responsive-grid` (one column below
NativeWind `xs`, two above). The list virtualizes pairs for grids; cell containers
own width and spacing. Cards must not impose another grid width. Headers scroll
with the content. Safe areas, keyboard avoidance and floating-tab padding come
from the shared `ScreenFrame`.

## Behavior

- Initial loading and retry are separate from append and refresh states.
- Automatic loading starts within half a viewport of the end. The accessible
  **Load more** button invokes the same guarded operation.
- Append failure retains cards and pauses automatic loading. Retry uses the same
  cursor. Pull-to-refresh cancels pending work and replaces all pages with page one
  on success; failure retains the previous cards and offers refresh retry.
- The hook serializes requests and invalidates stale completions even if a loader
  ignores cancellation. Services must still implement timeouts and pass signals
  through to their network requests.
- Cross-page identities merge in original order, with later entries updating
  earlier metadata. Repeated cursors and non-progressing pages stop automatic
  loading and offer refresh. Offset pagination can omit items when the remote
  catalog changes; client deduplication cannot provide a server snapshot guarantee.
- State and scrolling survive tab changes/detail navigation while mounted.
  Unmounting clears authority to update the list; there is no disk or cross-query
  cache. Wallet/session replacement continues to reset navigation.
- Virtualized vault cards skip entrance animations and reuse the existing
  service-scoped TVL cache. Home cards retain their previous sizing and animation.

## Verification

The retained service-mocked functional tests exercise both catalogs and a generic string-cursor
list, including refresh, retries, cancellation, overlapping identities and a large
odd-length grid. Native scrolling, keyboard focus and Dynamic Type require separate
simulator/device checks; these tests are not proof of live backend availability.
No functional or native checks were rerun for this documentation review.
