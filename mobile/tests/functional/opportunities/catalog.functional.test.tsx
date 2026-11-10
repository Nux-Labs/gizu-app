import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MainnetVaults } from "@/features/opportunities/MainnetVaults";
import { OpportunityServiceContext } from "@/features/opportunities/useOpportunities";
import type { OpportunityPage, OpportunityService } from "@/domain/opportunities";
import { deferred } from "../../support/renderApp";
import { tvlRecords } from "../../support/opportunities";
import { createOpportunityService } from "@/services/opportunities";
import { VaultPreview } from "@/features/investments/components/VaultPreview";
// The sparkline is decorative (hidden from assistive tech); query it explicitly.
const hidden = { includeHiddenElements: true };
const page: OpportunityPage = {
  page: 0,
  items: 8,
  total: 9,
  facets: {
    protocols: [
      { id: "aave", name: "Aave", count: 5 },
      { id: "morpho", name: "Morpho", count: 4 },
    ],
  },
  list: [
    {
      id: "1",
      name: "Lend USDC on Aave",
      chainId: 143,
      protocol: { id: "aave", name: "Aave" },
      status: "LIVE",
      totalApr: 6.1,
      tvl: 1000000,
    },
  ],
};
function setup(fail = false, chains?: OpportunityService["chains"]) {
  const list = jest
    .fn<ReturnType<OpportunityService["list"]>, Parameters<OpportunityService["list"]>>()
    .mockResolvedValue(page);
  if (fail) list.mockRejectedValueOnce(new Error("offline"));
  const tvl = jest
    .fn<
      ReturnType<OpportunityService["tvlRecords"]>,
      Parameters<OpportunityService["tvlRecords"]>
    >()
    .mockResolvedValue(tvlRecords);
  const detail = jest.fn<
    ReturnType<OpportunityService["detail"]>,
    Parameters<OpportunityService["detail"]>
  >();
  const onOpen = jest.fn<void, [string]>();
  const service: OpportunityService = {
    list,
    detail,
    tvlRecords: tvl,
    ...(chains ? { chains } : {}),
  };
  const view = render(
    <SafeAreaProvider>
      <OpportunityServiceContext.Provider value={service}>
        <MainnetVaults onOpen={onOpen} />
      </OpportunityServiceContext.Provider>
    </SafeAreaProvider>,
  );
  return { list, tvl, onOpen, ...view };
}
test("mainnet listing shows real metrics without investment actions and supports pagination and filters", async () => {
  const { list } = setup();
  expect(screen.getByLabelText("Loading vaults…")).toBeVisible();
  expect(await screen.findByText("Lend USDC on Aave")).toBeVisible();
  expect(screen.getByText("6.1% total APR")).toBeVisible();
  expect(screen.queryByRole("button", { name: /deposit|withdraw|buy/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
  list.mockResolvedValueOnce({
    ...page,
    page: 1,
    list: [{ ...page.list[0]!, id: "2", name: "Second vault" }],
  });
  await userEvent.press(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Second vault")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getByText("Lend USDC on Aave")).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "Morpho" }));
  await screen.findByText("Lend USDC on Aave");
  expect(list).toHaveBeenLastCalledWith(
    { search: "", protocol: "morpho", page: 0 },
    expect.anything(),
  );
  list.mockResolvedValueOnce({ ...page, list: [], total: 0 });
  fireEvent.changeText(screen.getByLabelText("Search opportunities"), "missing");
  expect(await screen.findByText("No vaults match your filters.")).toBeVisible();
  expect(list).toHaveBeenLastCalledWith(
    { search: "missing", protocol: "morpho", page: 0 },
    expect.anything(),
  );
  await userEvent.press(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByText("Lend USDC on Aave");
  expect(list).toHaveBeenLastCalledWith({ search: "", page: 0 }, expect.anything());
});
test("failure can be retried and old responses cannot replace new results", async () => {
  const { list } = setup(true);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Vault catalog unavailable. Please retry.",
  );
  await userEvent.press(screen.getByRole("button", { name: "Retry vaults" }));
  await screen.findByText("Lend USDC on Aave");
  const old = deferred<OpportunityPage>();
  list.mockReturnValueOnce(old.promise);
  fireEvent.changeText(screen.getByLabelText("Search opportunities"), "old");
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith({ search: "old", page: 0 }, expect.anything()),
  );
  const signal = list.mock.calls.at(-1)![1];
  list.mockResolvedValueOnce({ ...page, list: [], total: 0 });
  fireEvent.changeText(screen.getByLabelText("Search opportunities"), "new");
  expect(await screen.findByText("No vaults match your filters.")).toBeVisible();
  expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(page));
  expect(screen.queryByText("Lend USDC on Aave")).toBeNull();
});
test("cards draw a TVL sparkline and open their vault", async () => {
  const { tvl, onOpen } = setup();
  const card = await screen.findByRole("button", { name: "View Lend USDC on Aave" });
  expect(await within(card).findByText("+5.26%")).toBeVisible();
  expect(within(card).getByTestId("sparkline", hidden)).toBeTruthy();
  expect(tvl).toHaveBeenCalledWith("1", expect.anything());
  await userEvent.press(card);
  expect(onOpen).toHaveBeenCalledWith("1");
});
test("empty history draws a flat line instead of a no-data message", async () => {
  const { tvl } = setup();
  tvl.mockResolvedValue([]);
  const card = await screen.findByRole("button", { name: "View Lend USDC on Aave" });
  await waitFor(() => expect(within(card).getByTestId("sparkline", hidden)).toBeTruthy());
  expect(within(card).getByText("LIVE")).toBeVisible();
  expect(screen.queryByText(/no data/i)).toBeNull();
});
test("a failed history omits the sparkline without blocking the list", async () => {
  const { tvl } = setup();
  tvl.mockRejectedValue(new Error("offline"));
  const card = await screen.findByRole("button", { name: "View Lend USDC on Aave" });
  await waitFor(() => expect(tvl).toHaveBeenCalled());
  await act(async () => {});
  expect(within(card).queryByTestId("sparkline", hidden)).toBeNull();
  expect(within(card).getByText("6.1% total APR")).toBeVisible();
  expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
});

test("refresh replaces vault results and reuses successful sparkline history", async () => {
  const { list, tvl } = setup();
  await screen.findByText("Lend USDC on Aave");
  await waitFor(() => expect(tvl).toHaveBeenCalledTimes(1));
  list.mockResolvedValueOnce({
    ...page,
    page: 1,
    list: [{ ...page.list[0]!, id: "2", name: "Second vault" }],
  });
  fireEvent(screen.getByLabelText("vaults list"), "endReached");
  await screen.findByText("Second vault");
  list.mockResolvedValueOnce({ ...page, total: 1 });
  fireEvent(screen.getByLabelText("vaults list"), "refresh");
  await waitFor(() => expect(screen.queryByText("Second vault")).toBeNull());
  expect(list.mock.lastCall?.[0].page).toBe(0);
  expect(tvl.mock.calls.filter(([id]) => id === "1")).toHaveLength(1);
});

test("chainless catalog combines supported chains, retains protocol filters and only pages unfinished chains", async () => {
  const chainResponse = deferred<{ id: number; name: string }[]>();
  const chains = jest.fn().mockReturnValueOnce(chainResponse.promise);
  const { list } = setup(false, chains);
  list.mockImplementation(async (query) => ({
    ...page,
    page: query.page,
    total: query.chainId === 143 ? 9 : 1,
    partial: query.chainId === 1,
    // Per-chain options merge into one chip per protocol; Curvance is never offered.
    facets: {
      protocols:
        query.chainId === 143
          ? [
              { id: "morpho", name: "Morpho", count: 2 },
              { id: "aave", name: "Aave", count: 1 },
            ]
          : [{ id: "morpho", name: "Morpho", count: 1 }],
    },
    list: [
      {
        ...page.list[0]!,
        id: `${query.chainId}-${query.protocol ?? "all"}-${query.page}`,
        chainId: query.chainId!,
        name: `${query.protocol ?? "all"} vault ${query.chainId} page ${query.page}`,
      },
    ],
  }));
  expect(list).not.toHaveBeenCalled();
  await act(async () =>
    chainResponse.resolve([
      { id: 143, name: "Monad" },
      { id: 1, name: "Ethereum" },
      { id: 4663, name: "Robinhood" },
    ]),
  );
  expect(await screen.findByText("all vault 143 page 0")).toBeVisible();
  expect(screen.getByText("all vault 1 page 0")).toBeVisible();
  expect(screen.getByText("all vault 4663 page 0")).toBeVisible();
  expect(screen.queryByRole("radiogroup", { name: "Chain filter" })).toBeNull();
  for (const name of ["Robinhood", "Ethereum", "Monad"])
    expect(screen.queryByRole("radio", { name })).toBeNull();
  expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
    "Morpho",
    "Aave",
  ]);
  expect(screen.queryByRole("radio", { name: "All protocols" })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Some vaults are unavailable. Showing the available catalog.",
  );
  await userEvent.press(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("all vault 143 page 1")).toBeVisible();
  expect(screen.getByText("all vault 1 page 0")).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  expect(screen.queryByText("All vaults loaded.")).toBeNull();
  expect(
    list.mock.calls.filter(([query]) => query.page === 1).map(([query]) => query.chainId),
  ).toEqual([143]);
  await userEvent.press(screen.getByRole("radio", { name: "Morpho" }));
  expect(await screen.findByText("morpho vault 143 page 0")).toBeVisible();
  expect(screen.getByText("morpho vault 1 page 0")).toBeVisible();
  expect(screen.getByText("morpho vault 4663 page 0")).toBeVisible();
  expect(screen.queryByText("all vault 143 page 1")).toBeNull();
  // Choosing the selected protocol again clears it.
  await userEvent.press(screen.getByRole("radio", { name: "Morpho" }));
  expect(await screen.findByText("all vault 143 page 0")).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "Aave" }));
  expect(await screen.findByText("aave vault 143 page 0")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Clear filters" }));
  expect(await screen.findByText("all vault 143 page 0")).toBeVisible();
  expect(screen.getByText("all vault 4663 page 0")).toBeVisible();
});

test("a catalog with one protocol shows no protocol filter", async () => {
  const { list } = setup(false, jest.fn().mockResolvedValue([{ id: 143, name: "Monad" }]));
  list.mockResolvedValue({
    ...page,
    facets: { protocols: [{ id: "morpho", name: "Morpho", count: 1 }] },
  });
  expect(await screen.findByText("Lend USDC on Aave")).toBeVisible();
  expect(screen.queryByRole("radiogroup", { name: "Protocol filter" })).toBeNull();
});

test("chain endpoint failure retries without issuing a default-chain vault request", async () => {
  const chains = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([{ id: 4663, name: "Robinhood" }]);
  const { list } = setup(false, chains);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Vault catalog unavailable. Please retry.",
  );
  expect(list).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Retry vaults" }));
  await screen.findByText("Lend USDC on Aave");
  expect(list).toHaveBeenCalledWith({ search: "", chainId: 4663, page: 0 }, expect.anything());
});

test("Home preview combines the configured chains without a chain selector", async () => {
  const service: OpportunityService = {
    chains: jest.fn().mockResolvedValue([
      { id: 1, name: "Ethereum" },
      { id: 143, name: "Monad" },
    ]),
    list: jest.fn().mockImplementation(async (query) => ({
      ...page,
      list: [
        {
          ...page.list[0]!,
          id: `home-${query.chainId}`,
          name: `Home vault ${query.chainId}`,
          chainId: query.chainId,
        },
      ],
    })),
    detail: jest.fn(),
    tvlRecords: jest.fn().mockResolvedValue([]),
  };
  render(
    <SafeAreaProvider>
      <OpportunityServiceContext.Provider value={service}>
        <VaultPreview onOpen={jest.fn()} onSeeAll={jest.fn()} />
      </OpportunityServiceContext.Provider>
    </SafeAreaProvider>,
  );
  expect(await screen.findByText("Home vault 1")).toBeVisible();
  expect(screen.getByText("Home vault 143")).toBeVisible();
});

test("production catalog shows featured vaults alongside executable vaults and hides ordinary unsupported deposits", async () => {
  const originalFetch = global.fetch;
  const pendle = {
    ...page.list[0]!,
    id: "pendle",
    name: "Pendle USDC",
    chainId: 1,
    protocol: { id: "morpho", name: "Morpho" },
    vaultAddress: "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
  };
  const steakhouse = {
    ...pendle,
    id: "steakhouse",
    name: "Steakhouse USDG",
    chainId: 4663,
    vaultAddress: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
  };
  const own = {
    ...pendle,
    id: "gizu-prime",
    name: "Gizu Prime AUSD",
    chainId: 143,
    vaultAddress: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    featured: true,
  };
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const list = url.includes("chainId=143")
      ? [own]
      : url.includes("chainId=4663")
        ? [steakhouse]
        : [
            pendle,
            {
              ...pendle,
              id: "unsupported",
              name: "Unavailable deposit vault",
              vaultAddress: "0x1111111111111111111111111111111111111111",
            },
          ];
    return {
      ok: true,
      json: async () =>
        url.endsWith("/v1/chains")
          ? {
              list: [
                { id: 143, name: "Monad" },
                { id: 1, name: "Ethereum" },
                { id: 4663, name: "Robinhood" },
              ],
            }
          : url.includes("tvl-records")
            ? { list: [] }
            : { list, page: 0, items: 8, total: url.includes("chainId=143") ? 1 : 123 },
    } as Response;
  });
  global.fetch = fetcher;
  try {
    render(
      <SafeAreaProvider>
        <OpportunityServiceContext.Provider
          value={createOpportunityService("https://backend.example")}
        >
          <MainnetVaults onOpen={jest.fn()} />
          <VaultPreview onOpen={jest.fn()} onSeeAll={jest.fn()} />
        </OpportunityServiceContext.Provider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getAllByText("Pendle USDC")).toHaveLength(2));
    expect(screen.getAllByText("Steakhouse USDG")).toHaveLength(2);
    expect(screen.getAllByText("Gizu Prime AUSD")).toHaveLength(2);
    expect(screen.getAllByText("Featured")).toHaveLength(2);
    expect(screen.queryByText("Unavailable deposit vault")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("chainId=143"))).toBe(true);
  } finally {
    global.fetch = originalFetch;
  }
});
