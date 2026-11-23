import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Text } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type {
  FeedEvent,
  SealedAssetView,
  StrategyCard,
  StrategyDetail,
  StrategyService,
} from "@/domain/strategies";
import type { TokenCatalogService } from "@/domain/tokenCatalog";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { StrategiesScreen } from "@/features/strategies/StrategiesScreen";
import { StrategyHubScreen } from "@/features/strategies/StrategyHubScreen";
import { StrategyPriceScreen } from "@/features/strategies/StrategyPriceScreen";
import { StrategyProfileScreen } from "@/features/strategies/StrategyProfileScreen";
import { StrategyUpdateScreen } from "@/features/strategies/StrategyUpdateScreen";
import { StrategyFollowerContext } from "@/features/strategies/useStrategyFollower";
import {
  StrategyOwnerContext,
  type StrategyOwnerDeps,
} from "@/features/strategies/useStrategyOwner";
import { StrategySocialContext } from "@/features/strategies/useStrategySocial";
import { TokenCatalogContext } from "@/features/swap/useTokenCatalog";
import type { MainTabParamList, RootStackParamList } from "@/navigation/types";
import { createMemorySealRecordStore, type SealRecord } from "@/services/sealRecordStore";
import { createMemoryFollowStore } from "@/services/strategyFollows";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import {
  fakeSocial,
  historyEntry,
  quietCard,
  socialDeps,
  socialSigner,
} from "../../support/strategies";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const OTHER_SIGNER = "0x00000000000000000000000000000000000000aa";
const OWN_SIGNER = "0x00000000000000000000000000000000000000bb";
const NOW_MS = Date.parse("2026-11-23T12:00:00Z");
const DEADLINE = NOW_MS / 1000 + 600;
const signature = `0x${"ab".repeat(64)}1b`;
const word = (digit: string) => `0x${digit.repeat(64)}`;

const mockWallet = {
  session: { walletId: "wallet-1" },
  snapshot: mainnetPortfolio(
    "wallet-1",
    "0x1111111111111111111111111111111111111111",
    "5000000",
  ) as MainnetPortfolioSnapshot,
  refresh: jest.fn(async () => {}),
};
jest.mock("@/features/wallet/MainnetWalletProvider", () => ({
  useMainnetWallet: () => mockWallet,
  useOptionalMainnetWallet: () => mockWallet,
}));

const asset = (address: string, weightBps: number, id: string): SealedAssetView => ({
  chainId: 8453,
  kind: 0,
  address,
  weightBps,
  assetId: word(id),
});

function card(overrides: Partial<StrategyCard> = {}): StrategyCard {
  return {
    id: 7,
    signer: OTHER_SIGNER,
    name: "AI chips",
    embargoSeconds: 604800,
    monthlyPriceAtoms: "10000000",
    signalPriceAtoms: "500000",
    seats: 20,
    seatsTaken: 3,
    commits: 3,
    revealed: 2,
    broken: false,
    lastCommitAt: "2026-11-23T09:00:00Z",
    performance: {
      cumulativeReturnBps: 584,
      maxDrawdownBps: -200,
      closedPeriods: 2,
      complete: true,
    },
    earnedAtoms: "1500000",
    createdAt: "2026-10-01T00:00:00Z",
    registry: { chainId: 84532, address: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7" },
    ...quietCard,
    latestAssets: [asset(NVDA, 5000, "1"), asset(AAPL, 5000, "2")],
    ...overrides,
  };
}

const theirs = card();
const mine = card({
  id: 9,
  signer: OWN_SIGNER,
  name: "My basket",
  commits: 1,
  revealed: 0,
  performance: {
    cumulativeReturnBps: null,
    maxDrawdownBps: null,
    closedPeriods: 0,
    complete: true,
  },
  latestAssets: [],
  createdAt: "2026-11-20T00:00:00Z",
});

function detailOf(base: StrategyCard): StrategyDetail {
  return {
    ...base,
    history:
      base.id === 7
        ? [
            historyEntry({
              seq: 0,
              committedAt: "2026-10-02T00:00:00Z",
              revealedAt: "2026-10-09T00:00:00Z",
              assets: [asset(NVDA, 10000, "1")],
              periodReturnBps: 800,
            }),
            historyEntry({
              seq: 1,
              committedAt: "2026-11-01T00:00:00Z",
              revealedAt: "2026-11-08T00:00:00Z",
              assets: [asset(NVDA, 5000, "1"), asset(AAPL, 5000, "2")],
              periodReturnBps: -200,
              likes: 2,
            }),
          ]
        : [],
    priceHistory: [
      { version: 0, monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000", at: base.createdAt },
    ],
  };
}

const emptyCatalog: TokenCatalogService = {
  list: async () => ({ list: [], page: 0, items: 0, total: 0 }),
};

function setup(
  options: {
    initial?: keyof RootStackParamList;
    params?: Record<string, unknown>;
    feed?: FeedEvent[];
    ownStrategyId?: number | null;
    cards?: StrategyCard[];
    sealed?: SealRecord[];
  } = {},
) {
  let cards = options.cards ?? [theirs, mine];
  const service = {
    list: jest.fn(async (signers?: readonly string[]) =>
      signers ? cards.filter((c) => signers.includes(c.signer)) : cards,
    ),
    detail: jest.fn(async (id: number) => detailOf(cards.find((c) => c.id === id)!)),
    create: jest.fn(),
    commit: jest.fn(),
    subscribe: jest.fn(),
    signal: jest.fn(async () => null),
    changePrice: jest.fn(
      async (id: number, request: { version: number; monthlyPriceAtoms: string }) => {
        cards = cards.map((c) =>
          c.id === id
            ? {
                ...c,
                priceVersion: request.version,
                monthlyPriceAtoms: request.monthlyPriceAtoms,
                priceChangeAllowedAt: "2026-11-30T12:00:00.000Z",
              }
            : c,
        );
        return detailOf(cards.find((c) => c.id === id)!);
      },
    ),
  } satisfies StrategyService;
  const social = fakeSocial({ feed: options.feed, ownerName: "My basket" });
  const signer = socialSigner();
  const strategySigner = {
    strategyAddresses: jest.fn(async () => [OWN_SIGNER]),
    createStrategy: jest.fn(),
    sealStrategyCommit: jest.fn(),
  };
  const pricer = {
    signPrice: jest.fn(async () => ({ signer: OWN_SIGNER, signature })),
  };
  const owner: StrategyOwnerDeps = {
    service,
    signer: () => strategySigner as never,
    now: () => NOW_MS,
    sealRecords: createMemorySealRecordStore(options.sealed),
    pricer: () => pricer,
  };
  const follower = {
    service,
    follows: createMemoryFollowStore(),
    push: {
      api: { register: jest.fn(), follow: jest.fn(), remove: jest.fn() },
      platform: { token: jest.fn(async () => null) },
    },
    swap: () => null,
    now: () => NOW_MS,
  };
  const Stack = createNativeStackNavigator<RootStackParamList>();
  const Tabs = createBottomTabNavigator<MainTabParamList>();
  render(
    <SafeAreaProvider>
      <TokenCatalogContext.Provider value={emptyCatalog}>
        <StrategySocialContext.Provider
          value={socialDeps(social.service, {
            signer,
            ownStrategyId: options.ownStrategyId ?? null,
            nowMs: NOW_MS,
          })}
        >
          <StrategyFollowerContext.Provider value={follower}>
            <StrategyOwnerContext.Provider value={owner}>
              <NavigationContainer>
                <Stack.Navigator
                  initialRouteName={options.initial ?? "Main"}
                  screenOptions={{ headerShown: false }}
                >
                  <Stack.Screen name="Main">
                    {() => (
                      <Tabs.Navigator screenOptions={{ headerShown: false }}>
                        <Tabs.Screen name="StrategyHub" component={StrategyHubScreen} />
                      </Tabs.Navigator>
                    )}
                  </Stack.Screen>
                  <Stack.Screen
                    name="StrategyDetail"
                    component={StrategyProfileScreen}
                    initialParams={options.params as never}
                  />
                  <Stack.Screen name="StrategyUpdate" component={StrategyUpdateScreen} />
                  <Stack.Screen name="StrategyPrice" component={StrategyPriceScreen} />
                  <Stack.Screen name="Strategies" component={StrategiesScreen} />
                  <Stack.Screen name="StrategyPublish">
                    {({ route }) => <Text>Publish opened with {JSON.stringify(route.params)}</Text>}
                  </Stack.Screen>
                </Stack.Navigator>
              </NavigationContainer>
            </StrategyOwnerContext.Provider>
          </StrategyFollowerContext.Provider>
        </StrategySocialContext.Provider>
      </TokenCatalogContext.Provider>
    </SafeAreaProvider>,
  );
  return { service, social, signer, pricer };
}

test("the feed shows sealed updates without weights, reveals with what changed, and price changes", async () => {
  const { social } = setup({
    feed: [
      {
        kind: "sealed",
        strategyId: 7,
        strategyName: "AI chips",
        seq: 2,
        at: "2026-11-23T09:00:00Z",
      },
      {
        kind: "revealed",
        strategyId: 7,
        strategyName: "AI chips",
        seq: 1,
        at: "2026-11-08T00:00:00Z",
        assets: [asset(NVDA, 5000, "1"), asset(AAPL, 5000, "2")],
        previousAssets: [asset(NVDA, 10000, "1")],
        periodReturnBps: -200,
        likes: 2,
        comments: 0,
        liked: false,
      },
      {
        kind: "price",
        strategyId: 7,
        strategyName: "AI chips",
        version: 1,
        at: "2026-11-05T00:00:00Z",
        monthlyPriceAtoms: "12000000",
        signalPriceAtoms: "500000",
        previous: { monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000" },
      },
    ],
  });
  expect(
    await screen.findByText(/sealed update 2\. Its weights stay hidden until the embargo ends\./),
  ).toBeVisible();
  // Following nobody yet, the feed shows everyone.
  expect(social.service.feed).toHaveBeenCalledWith(null, null, null, expect.anything());
  const reveal = screen.getByLabelText("AI chips update 1");
  expect(within(reveal).getByText("+AAPLc on Base 50%")).toBeVisible();
  expect(within(reveal).getByText("NVDAc on Base 100% → 50%")).toBeVisible();
  expect(within(reveal).getByText("Period return -2.00%, verified on Base")).toBeVisible();
  expect(within(reveal).getByLabelText("2 likes")).toBeVisible();
  expect(screen.getByText(/changed its price to \$12\.00 a month/)).toBeVisible();
});

test("discover ranks by record, sorts and filters from sheets, and searches names and holdings", async () => {
  setup();
  fireEvent.press(await screen.findByRole("tab", { name: "Discover" }));
  // Neither has the 3 reveals and 14 days a ranking by return needs, so both wait below it.
  const own = await screen.findByRole("button", { name: "Open strategy My basket" });
  expect(within(own).getByText("Yours")).toBeVisible();
  expect(within(own).getByText("New")).toBeVisible();
  expect(screen.getByText("Not ranked yet")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open strategy AI chips" })).toBeVisible();

  // Sorting is one button that opens a sheet.
  fireEvent.press(screen.getByRole("button", { name: "Sort: Top return" }));
  fireEvent.press(await screen.findByRole("radio", { name: "Lowest price" }));
  expect(await screen.findByRole("button", { name: "Sort: Lowest price" })).toBeVisible();
  expect(screen.queryByText("Not ranked yet")).toBeNull();

  // Filters are chosen in a sheet that says how many strategies they leave.
  fireEvent.press(screen.getByRole("button", { name: "Filters" }));
  fireEvent.press(await screen.findByRole("radio", { name: "Mostly stocks" }));
  fireEvent.press(screen.getByRole("radio", { name: "Worst drop under 10%" }));
  fireEvent.press(screen.getByRole("button", { name: "Show 1 strategy" }));
  expect(await screen.findByRole("button", { name: "Filters, 2 on" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open strategy AI chips" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open strategy My basket" })).toBeNull();

  // Each chosen filter shows as a chip that removes it.
  fireEvent.press(screen.getByRole("button", { name: "Remove filter Mostly stocks" }));
  fireEvent.press(screen.getByRole("button", { name: "Remove filter Worst drop under 10%" }));
  expect(await screen.findByRole("button", { name: "Open strategy My basket" })).toBeVisible();

  // Search matches a strategy's name or an asset in its newest revealed basket.
  fireEvent.changeText(screen.getByLabelText("Search strategies or assets"), "aapl");
  expect(screen.getByRole("button", { name: "Open strategy AI chips" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open strategy My basket" })).toBeNull();
  fireEvent.changeText(screen.getByLabelText("Search strategies or assets"), "my bas");
  expect(screen.getByRole("button", { name: "Open strategy My basket" })).toBeVisible();
  fireEvent.changeText(screen.getByLabelText("Search strategies or assets"), "zzz");
  expect(screen.getByText("No strategy matches these filters.")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Clear search and filters" }));
  expect(await screen.findByRole("button", { name: "Open strategy AI chips" })).toBeVisible();
});

test("liking signs in once with the passkey, then toggles without asking again", async () => {
  const { social, signer } = setup({ initial: "StrategyDetail", params: { id: 7 } });
  fireEvent.press(await screen.findByRole("button", { name: "Like AI chips" }));
  await waitFor(() =>
    expect(social.service.like).toHaveBeenCalledWith(expect.any(String), 7, null),
  );
  expect(signer.signIn).toHaveBeenCalledWith("wallet-1", 84532, word("5"), 1_900_000_000, null);
  expect(social.service.createSession).toHaveBeenCalledWith(
    expect.not.objectContaining({ ownerLink: expect.anything() }),
  );
  expect(await screen.findByRole("button", { name: "Unlike AI chips" })).toBeVisible();

  fireEvent.press(screen.getByRole("button", { name: "Unlike AI chips" }));
  expect(await screen.findByRole("button", { name: "Like AI chips" })).toBeVisible();
  expect(social.service.unlike).toHaveBeenCalledWith(expect.any(String), 7, null);
  expect(signer.signIn).toHaveBeenCalledTimes(1);
});

test("comments appear under the automatic nickname; you delete your own and report others'", async () => {
  const { social } = setup({ initial: "StrategyDetail", params: { id: 7 } });
  social.seed(7, null, "Why the AAPL add?", "Brave Heron #9f2a");
  fireEvent.press(await screen.findByRole("tab", { name: "Comments" }));
  expect(await screen.findByText("Why the AAPL add?")).toBeVisible();

  fireEvent.changeText(screen.getByLabelText("Comment on this strategy"), "  Following this one  ");
  fireEvent.press(screen.getByRole("button", { name: "Post" }));
  const mineRow = await screen.findByLabelText("Comment by Calm Otter #50c1");
  expect(within(mineRow).getByText("Following this one")).toBeVisible();
  expect(social.service.postComment).toHaveBeenCalledWith(expect.any(String), 7, {
    body: "Following this one",
    seq: null,
    parentId: null,
  });

  // Reply to the other comment, then report it.
  const other = screen.getByLabelText("Comment by Brave Heron #9f2a");
  fireEvent.press(within(other).getByRole("button", { name: "Reply" }));
  fireEvent.changeText(
    screen.getByLabelText("Reply to Brave Heron #9f2a"),
    "Diversifying, I think",
  );
  fireEvent.press(screen.getAllByRole("button", { name: "Post" })[1]!);
  await waitFor(() =>
    expect(social.service.postComment).toHaveBeenLastCalledWith(expect.any(String), 7, {
      body: "Diversifying, I think",
      seq: null,
      parentId: 1,
    }),
  );
  fireEvent.press(
    within(screen.getByLabelText("Comment by Brave Heron #9f2a")).getByRole("button", {
      name: "Report",
    }),
  );
  await waitFor(() => expect(screen.queryByText("Why the AAPL add?")).toBeNull(), {
    timeout: 3000,
  });
  expect(social.service.reportComment).toHaveBeenCalledWith(expect.any(String), 1);

  fireEvent.press(
    within(screen.getByLabelText("Comment by Calm Otter #50c1")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(screen.queryByText("Following this one")).toBeNull(), {
    timeout: 3000,
  });
  expect(social.service.deleteComment).toHaveBeenCalled();
});

test("an owner speaks as the strategy and can hide comments on it", async () => {
  const { social, signer } = setup({
    initial: "StrategyDetail",
    params: { id: 9 },
    ownStrategyId: 9,
  });
  social.seed(9, null, "spam spam", "Loud Crow #0001");
  fireEvent.press(await screen.findByRole("tab", { name: "Comments" }));
  expect(await screen.findByText("spam spam")).toBeVisible();
  fireEvent.changeText(screen.getByLabelText("Comment on this strategy"), "Rebalanced today");
  fireEvent.press(screen.getByRole("button", { name: "Post" }));

  const own = await screen.findByLabelText("Comment by My basket");
  expect(within(own).getByText("Owner")).toBeVisible();
  expect(signer.signIn).toHaveBeenCalledWith("wallet-1", 84532, word("5"), 1_900_000_000, 9);
  expect(social.service.createSession).toHaveBeenCalledWith(
    expect.objectContaining({ ownerLink: { strategyId: 9, signature: expect.any(String) } }),
  );
  fireEvent.press(
    within(screen.getByLabelText("Comment by Loud Crow #0001")).getByRole("button", {
      name: "Hide",
    }),
  );
  await waitFor(() => expect(screen.queryByText("spam spam")).toBeNull(), { timeout: 3000 });
  expect(social.service.hideComment).toHaveBeenCalledWith(expect.any(String), 1);
});

test("each revealed update opens its own comment thread", async () => {
  const { social } = setup({ initial: "StrategyDetail", params: { id: 7 } });
  fireEvent.press(await screen.findByRole("button", { name: "0 comments on AI chips update 1" }));
  expect(await screen.findByText("Comments")).toBeVisible();
  fireEvent.changeText(await screen.findByLabelText("Comment on update 1"), "Nice timing");
  fireEvent.press(screen.getByRole("button", { name: "Post" }));
  await waitFor(() =>
    expect(social.service.postComment).toHaveBeenCalledWith(expect.any(String), 7, {
      body: "Nice timing",
      seq: 1,
      parentId: null,
    }),
  );
  expect(await screen.findByText("Nice timing")).toBeVisible();
});

test("the owner sees when trades changed the portfolio and changes the price once a week", async () => {
  const { service, pricer } = setup({
    initial: "StrategyDetail",
    params: { id: 9 },
    // Sealed with 1 USDC of cash; the wallet now holds 5.
    sealed: [{ strategyId: 9, sealedAt: "2026-11-20T00:00:00Z", amounts: { cash: "1000000" } }],
  });
  expect(await screen.findByText(/Your portfolio changed since your last update/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Start free trial" })).toBeNull();

  fireEvent.press(screen.getByRole("button", { name: "Change price" }));
  const monthly = await screen.findByLabelText("New monthly price in USDC");
  expect(monthly.props.value).toBe("10");
  expect(screen.getByRole("button", { name: "Save new price" })).toBeDisabled();
  fireEvent.changeText(monthly, "12");
  fireEvent.press(screen.getByRole("button", { name: "Save new price" }));

  await waitFor(() => expect(service.changePrice).toHaveBeenCalled());
  expect(pricer.signPrice).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    9,
    1,
    "12000000",
    "500000",
    DEADLINE,
  );
  expect(service.changePrice).toHaveBeenCalledWith(9, {
    version: 1,
    monthlyPriceAtoms: "12000000",
    signalPriceAtoms: "500000",
    deadline: DEADLINE,
    signature,
  });
  // Back on the profile, the next change waits a week.
  expect(await screen.findByText("The price can change again on 2026-11-30.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Change price" })).toBeDisabled();
});

test("a wallet that already sells a strategy goes straight to its profile", async () => {
  setup({ initial: "Strategies" });
  expect(await screen.findByRole("button", { name: "Send update" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
});
