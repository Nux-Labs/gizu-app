import { AppRoot } from "@/application/AppRoot";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SwapScreen } from "@/features/swap/SwapScreen";
import { TokenCatalogContext } from "@/features/swap/useTokenCatalog";
import type { TokenCatalogService, TokenPage } from "@/domain/tokenCatalog";
import { catalogPage, catalogToken } from "../../support/tokenCatalog";
import { deferred } from "../../support/renderApp";
function open(
  list = jest
    .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
    .mockResolvedValue(catalogPage),
) {
  const view = render(
    <SafeAreaProvider>
      <TokenCatalogContext.Provider value={{ list }}>
        <SwapScreen />
      </TokenCatalogContext.Provider>
    </SafeAreaProvider>,
  );
  return { ...view, list };
}
test("defaults to Robinhood RWA and exposes catalog metadata without transaction actions", async () => {
  const { list } = open();
  expect(await screen.findByText("Amazon")).toBeVisible();
  expect(list).toHaveBeenCalledWith(
    { chainId: 4663, category: "rwa", search: "", page: 0 },
    expect.anything(),
  );
  for (const text of ["Issuer: Robinhood", "Listed on 1inch"])
    expect(screen.getByText(text)).toBeVisible();
  expect(screen.queryByText(catalogToken.address)).toBeNull();
  expect(screen.getByText(/does not establish Fusion/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getByText("All tokens loaded.")).toBeVisible();
  fireEvent(screen.getByLabelText("AMZN logo"), "error");
  expect(screen.getByLabelText("AMZN logo unavailable")).toBeVisible();
});
test("browses pages, debounces search, resets pagination and preserves filters on network changes", async () => {
  const { list } = open(
    jest
      .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
      .mockResolvedValue({ ...catalogPage, total: 21 }),
  );
  await screen.findByText("Amazon");
  fireEvent.press(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Amazon");
  expect(list.mock.lastCall?.[0].page).toBe(1);
  fireEvent.press(screen.getByRole("radio", { name: "All" }));
  await screen.findByText("Amazon");
  jest.useFakeTimers();
  fireEvent.changeText(screen.getByLabelText("Search tokens"), "A");
  fireEvent.changeText(screen.getByLabelText("Search tokens"), "AMZN");
  const count = list.mock.calls.length;
  await act(() => jest.advanceTimersByTimeAsync(299));
  expect(list).toHaveBeenCalledTimes(count);
  await act(() => jest.advanceTimersByTimeAsync(1));
  expect(list.mock.lastCall?.[0]).toMatchObject({ search: "AMZN", page: 0 });
  jest.useRealTimers();
  for (const [name, chainId] of [
    ["Ethereum", 1],
    ["Monad", 143],
    ["Robinhood", 4663],
  ] as const) {
    fireEvent.press(screen.getByRole("radio", { name }));
    await screen.findByText("Amazon");
    expect(list.mock.lastCall?.[0]).toEqual({ chainId, category: "all", search: "AMZN", page: 0 });
  }
  fireEvent.press(screen.getByRole("radio", { name: "RWA" }));
  await screen.findByText("Amazon");
  expect(list.mock.lastCall?.[0].category).toBe("rwa");
});
afterEach(() => jest.useRealTimers());
test("shows unavailable, retries and handles empty results without fixture fallback", async () => {
  open(
    jest
      .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue({ ...catalogPage, list: [], total: 0 }),
  );
  expect(await screen.findByText(/Token catalog unavailable/)).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Retry tokens" }));
  expect(await screen.findByText("No tokens match your filters.")).toBeVisible();
  expect(screen.queryByText("Amazon")).toBeNull();
});
test("aborts superseded requests, ignores stale success/failure and aborts on unmount", async () => {
  const old = deferred<TokenPage>();
  const staleFailure = deferred<TokenPage>();
  const list = jest
    .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(staleFailure.promise)
    .mockResolvedValue({ ...catalogPage, list: [], total: 0 });
  const { unmount } = open(list);
  expect(screen.getByLabelText("Loading tokens…")).toBeVisible();
  fireEvent.press(screen.getByRole("radio", { name: "Ethereum" }));
  expect(list.mock.calls[0]?.[1].aborted).toBe(true);
  fireEvent.press(screen.getByRole("radio", { name: "Monad" }));
  await screen.findByText("No tokens match your filters.");
  await act(async () => {
    old.resolve(catalogPage);
    staleFailure.reject(new Error("stale"));
  });
  expect(screen.queryByText("Amazon")).toBeNull();
  expect(screen.queryByText(/Token catalog unavailable/)).toBeNull();
  const pending = deferred<TokenPage>();
  list.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole("radio", { name: "Ethereum" }));
  unmount();
  expect(list.mock.lastCall?.[1].aborted).toBe(true);
  await act(async () => pending.resolve(catalogPage));
});
test("falls back for missing/unsafe logos and displays unlisted assets with shared symbols", async () => {
  open(
    jest
      .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
      .mockResolvedValue({
        ...catalogPage,
        total: 2,
        list: [
          { ...catalogToken, logoURI: null, issuer: null, category: "other", swapListed: false },
          {
            ...catalogToken,
            address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            logoURI: "file:///secret",
          },
        ],
      }),
  );
  await screen.findByText("Other asset");
  expect(screen.getByText("Not listed on 1inch")).toBeVisible();
  expect(screen.getAllByLabelText("AMZN logo unavailable")).toHaveLength(2);
});

test("release-mode navigation opens native Swap and handles an unavailable token service", async () => {
  const runtime = globalThis as unknown as { __DEV__: boolean };
  const development = runtime.__DEV__;
  runtime.__DEV__ = false;
  const fetchTokens = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
  try {
    render(
      <AppRoot
        accessService={{
          request: jest.fn().mockResolvedValue({ kind: "demo", method: "Demo passkey" }),
        }}
      />,
    );
    await screen.findByRole("button", { name: "Continue with passkey" });
    fireEvent.press(await screen.findByRole("button", { name: "Continue with passkey" }));
    fireEvent.press(await screen.findByLabelText("Swap tab"));
    expect(await screen.findByText("Token list unavailable.")).toBeVisible();
    expect(screen.getByLabelText("Amount in USDC")).toBeVisible();
    expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
    expect(screen.queryByLabelText("Search tokens")).toBeNull();
  } finally {
    fetchTokens.mockRestore();
    runtime.__DEV__ = development;
  }
});

test("appends tokens and refreshes the first page without losing filters", async () => {
  const { list } = open(
    jest
      .fn<ReturnType<TokenCatalogService["list"]>, Parameters<TokenCatalogService["list"]>>()
      .mockResolvedValueOnce({ ...catalogPage, total: 21 })
      .mockResolvedValueOnce({
        ...catalogPage,
        page: 1,
        total: 21,
        list: [{ ...catalogToken, address: "0x" + "2".repeat(40), name: "Second token" }],
      })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(catalogPage),
  );
  await screen.findByText("Amazon");
  fireEvent(screen.getByLabelText("tokens list"), "endReached");
  await screen.findByText("Second token");
  expect(screen.getByText("Amazon")).toBeVisible();
  fireEvent(screen.getByLabelText("tokens list"), "refresh");
  await screen.findByRole("button", { name: "Retry refresh" });
  expect(screen.getByText("Second token")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Retry refresh" }));
  await screen.findByText("All tokens loaded.");
  expect(screen.queryByText("Second token")).toBeNull();
  expect(list.mock.lastCall?.[0]).toEqual({ chainId: 4663, category: "rwa", search: "", page: 0 });
});
