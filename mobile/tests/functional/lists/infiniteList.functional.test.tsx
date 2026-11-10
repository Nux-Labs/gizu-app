import { useCallback, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { InfiniteListScreen } from "@/components/templates/InfiniteListScreen";
import { SearchInput } from "@/components/atoms/SearchInput";
import { Typography } from "@/components/atoms/Typography";
import { useInfiniteList, type InfinitePage } from "@/hooks/useInfiniteList";
import { deferred } from "../../support/renderApp";
type Item = { id: string; name: string };
type Page = InfinitePage<Item, string>;
type Loader = (cursor: string, signal: AbortSignal, query: string) => Promise<Page>;
const identity = (item: Item) => item.id;
const first: Page = { items: [{ id: "a", name: "First" }], nextCursor: "second" };
function Fixture({ loader, layout = "list" }: { loader: Loader; layout?: "list" | "grid" }) {
  const [query, setQuery] = useState("");
  const loadPage = useCallback(
    (cursor: string, signal: AbortSignal) => loader(cursor, signal, query),
    [loader, query],
  );
  const list = useInfiniteList({
    queryKey: query,
    initialCursor: "first",
    loadPage,
    getIdentity: identity,
  });
  return (
    <InfiniteListScreen
      list={list}
      queryKey={query}
      getIdentity={identity}
      noun="examples"
      layout={layout}
      emptyMessage="Nothing found"
      unavailableMessage="Unavailable"
      renderItem={(item) => <Typography>{item.name}</Typography>}
      header={
        <SearchInput
          label="Search examples"
          value={query}
          onChangeText={(next) => {
            list.invalidate();
            setQuery(next);
          }}
        />
      }
    />
  );
}
function open(loader: Loader, layout?: "list" | "grid") {
  return render(
    <SafeAreaProvider>
      <Fixture loader={loader} layout={layout} />
    </SafeAreaProvider>,
  );
}
const endReached = () => fireEvent(screen.getByLabelText("examples list"), "endReached");
const refresh = () => fireEvent(screen.getByLabelText("examples list"), "refresh");
test("serializes duplicate end events, merges identities in order and stops at exhaustion", async () => {
  const next = deferred<Page>();
  const loader = jest
    .fn<ReturnType<Loader>, Parameters<Loader>>()
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(next.promise);
  open(loader);
  await screen.findByText("First");
  endReached();
  endReached();
  endReached();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.getByText("First")).toBeVisible();
  expect(screen.getByText("Loading more…")).toBeVisible();
  await act(async () =>
    next.resolve({
      items: [
        { id: "a", name: "Updated first" },
        { id: "b", name: "Second" },
      ],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByText("Updated first")).toBeVisible();
  expect(screen.getByText("Second")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.queryByText("All examples loaded.")).toBeNull();
  endReached();
  expect(loader).toHaveBeenCalledTimes(2);
});
test("append failure retains items, blocks automatic retries, and retries the failed cursor", async () => {
  const loader = jest
    .fn<ReturnType<Loader>, Parameters<Loader>>()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [{ id: "b", name: "Second" }], nextCursor: null });
  open(loader);
  await screen.findByText("First");
  endReached();
  await screen.findByRole("button", { name: "Retry loading more" });
  endReached();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.getByText("First")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Retry loading more" }));
  await screen.findByText("Second");
  expect(loader.mock.calls.map(([cursor]) => cursor)).toEqual(["first", "second", "second"]);
});
test("refresh aborts append, ignores stale success, retains data on failure and retries first page", async () => {
  const old = deferred<Page>();
  const fresh = deferred<Page>();
  const loader = jest
    .fn<ReturnType<Loader>, Parameters<Loader>>()
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise)
    .mockResolvedValueOnce({ items: [{ id: "c", name: "Fresh" }], nextCursor: null });
  open(loader);
  await screen.findByText("First");
  endReached();
  refresh();
  refresh();
  expect(loader).toHaveBeenCalledTimes(3);
  expect(loader.mock.calls[1]?.[1].aborted).toBe(true);
  expect(screen.getByText("First")).toBeVisible();
  await act(async () => {
    old.resolve({ items: [{ id: "x", name: "Stale" }], nextCursor: null });
    fresh.reject(new Error("offline"));
  });
  expect(screen.queryByText("Stale")).toBeNull();
  expect(screen.getByText(/Could not refresh/)).toBeVisible();
  endReached();
  expect(loader).toHaveBeenCalledTimes(3);
  fireEvent.press(screen.getByRole("button", { name: "Retry refresh" }));
  await screen.findByText("Fresh");
  expect(screen.queryByText("First")).toBeNull();
  expect(loader.mock.lastCall?.[0]).toBe("first");
});
test.each(["first", "third", null])(
  "repeated cursor or duplicate-only page (%s) requires refresh",
  async (cursor) => {
    const loader = jest
      .fn<ReturnType<Loader>, Parameters<Loader>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...first, nextCursor: cursor })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    open(loader);
    await screen.findByText("First");
    endReached();
    await screen.findByText("The catalog changed. Refresh to continue.");
    endReached();
    expect(loader).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByRole("button", { name: "Retry refresh" }));
    await screen.findByText("Nothing found");
  },
);
test("query changes and unmount cancel requests; late failures cannot change the new query", async () => {
  const old = deferred<Page>();
  const pending = deferred<Page>();
  const loader = jest
    .fn<ReturnType<Loader>, Parameters<Loader>>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ items: [], nextCursor: null })
    .mockReturnValueOnce(pending.promise);
  const view = open(loader);
  fireEvent.changeText(screen.getByLabelText("Search examples"), "new");
  expect(loader.mock.calls[0]?.[1].aborted).toBe(true);
  await screen.findByText("Nothing found");
  await act(async () => old.reject(new Error("stale")));
  expect(screen.queryByText("Unavailable")).toBeNull();
  fireEvent.changeText(screen.getByLabelText("Search examples"), "last");
  view.unmount();
  expect(loader.mock.lastCall?.[1].aborted).toBe(true);
  await act(async () => pending.resolve(first));
});
test("large odd-length grids keep a bounded render window after scroll events", async () => {
  const items = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), name: `Item ${i}` }));
  const loader = jest
    .fn<ReturnType<Loader>, Parameters<Loader>>()
    .mockResolvedValue({ items, nextCursor: null });
  open(loader, "grid");
  await screen.findByText("Item 0");
  expect(screen.queryByText("Item 500")).toBeNull();
  expect(screen.queryAllByText(/^Item /).length).toBeLessThan(100);
  const list = screen.getByLabelText("examples list");
  fireEvent(list, "layout", { nativeEvent: { layout: { width: 390, height: 700 } } });
  fireEvent(list, "contentSizeChange", 390, 50100);
  fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { x: 0, y: 25000 },
      contentSize: { width: 390, height: 50100 },
      layoutMeasurement: { width: 390, height: 700 },
    },
  });
  await waitFor(() => expect(screen.queryAllByText(/^Item /).length).toBeLessThan(200));
  expect(loader).toHaveBeenCalledTimes(1);
});
