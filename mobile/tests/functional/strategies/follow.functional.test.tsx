import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type {
  SealedAssetView,
  StrategyCard,
  StrategyDetail,
  StrategyService,
  StrategySignal,
} from "@/domain/strategies";
import type { MainnetPortfolioSnapshot, StoredSwapView } from "@/domain/wallet/storedSigner";
import { StrategyDetailScreen } from "@/features/strategies/StrategyDetailScreen";
import { StrategyExploreScreen } from "@/features/strategies/StrategyExploreScreen";
import {
  StrategyFollowerContext,
  type StrategyFollowerDeps,
} from "@/features/strategies/useStrategyFollower";
import { strategyLinkFor } from "@/navigation/strategyNotificationLinks";
import type { RootStackParamList } from "@/navigation/types";
import { ApiError } from "@/services/http";
import { createMemoryFollowStore, type FollowedStrategy } from "@/services/strategyFollows";
import { mainnetPortfolio } from "../../support/mainnetWallet";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEVICE = "6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f";
const NOW_MS = Date.parse("2026-11-23T12:00:00Z");
const word = (digit: string) => `0x${digit.repeat(64)}`;

const mockRefresh = jest.fn(async () => undefined);
const mockWallet = {
  session: { walletId: "wallet-1" },
  snapshot: mainnetPortfolio(
    "wallet-1",
    "0x1111111111111111111111111111111111111111",
    "500000000",
  ) as MainnetPortfolioSnapshot,
  refreshAfterAction: mockRefresh,
};
jest.mock("@/features/wallet/MainnetWalletProvider", () => ({
  useMainnetWallet: () => mockWallet,
  useOptionalMainnetWallet: () => mockWallet,
}));

const asset = (
  chainId: number,
  kind: 0 | 1,
  address: string,
  weightBps: number,
  id: string,
): SealedAssetView => ({
  chainId,
  kind,
  address,
  weightBps,
  assetId: word(id),
});

function card(overrides: Partial<StrategyCard> = {}): StrategyCard {
  return {
    id: 7,
    signer: "0x0000000000000000000000000000000000000001",
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
      cumulativeReturnBps: 1250,
      maxDrawdownBps: -300,
      closedPeriods: 2,
      complete: true,
    },
    earnedAtoms: "0",
    createdAt: "2026-11-01T00:00:00Z",
    registry: { chainId: 84532, address: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7" },
    ...overrides,
  };
}

function setup(options: {
  assets: SealedAssetView[];
  follows?: FollowedStrategy[];
  swapPhases?: string[];
  openSwap?: boolean;
  initial?: keyof RootStackParamList;
}) {
  const signal: StrategySignal = {
    seq: 2,
    commitment: word("c"),
    committedAt: "2026-11-23T09:00:00Z",
    commitTx: word("d"),
    assets: options.assets,
    salt: word("5"),
  };
  const detail: StrategyDetail = {
    ...card(),
    history: [
      {
        seq: 0,
        committedAt: "2026-11-02T00:00:00Z",
        revealedAt: "2026-11-09T00:00:00Z",
        commitTx: null,
        revealTx: null,
        assets: [asset(8453, 0, NVDA, 10000, "1")],
        periodReturnBps: 800,
      },
    ],
  };
  const service = {
    list: jest.fn(async () => [card(), card({ id: 8, name: "Nothing yet", commits: 0 })]),
    detail: jest.fn(async () => detail),
    create: jest.fn(),
    commit: jest.fn(),
    subscribe: jest.fn(async () => ({
      subscriberKey: word("a"),
      expiresAt: "2026-12-23T12:00:00Z",
    })),
    signal: jest.fn(async () => signal),
  } satisfies StrategyService;
  const follows = createMemoryFollowStore(options.follows);
  const api = {
    register: jest.fn(async () => DEVICE),
    follow: jest.fn(async () => true),
    remove: jest.fn(),
  };
  const platform = { token: jest.fn(async () => "fcm-token-0123456789") };
  const phases = [...(options.swapPhases ?? [])];
  const swap = {
    getSwapStatus: jest.fn(async () =>
      options.openSwap ? swapView("PAUSED", NVDA) : ({ phase: "NONE" } as const),
    ),
    startSwap: jest.fn(async (target: string) => swapView(phases.shift() ?? "COMPLETE", target)),
  };
  const deps: StrategyFollowerDeps = {
    service,
    follows,
    push: { api, platform },
    swap: () => swap,
    now: () => NOW_MS,
  };
  const Stack = createNativeStackNavigator<RootStackParamList>();
  render(
    <SafeAreaProvider>
      <StrategyFollowerContext.Provider value={deps}>
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={options.initial ?? "StrategyExplore"}
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen name="StrategyExplore" component={StrategyExploreScreen} />
            <Stack.Screen
              name="StrategyDetail"
              component={StrategyDetailScreen}
              initialParams={{ id: 7 }}
            />
            <Stack.Screen name="Earn">
              {({ route }) => <Text>Earn opened with {JSON.stringify(route.params)}</Text>}
            </Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      </StrategyFollowerContext.Provider>
    </SafeAreaProvider>,
  );
  return { service, follows, api, platform, swap };
}

/** The fields the copy reads; the native view has more. */
function swapView(phase: string, target: string): StoredSwapView {
  return {
    operationId: "op",
    phase,
    step: "",
    fundingAddress: "0x1111111111111111111111111111111111111111",
    targetSymbol: target,
    direction: "buy",
  } as unknown as StoredSwapView;
}

test("a follower starts a trial, sees the sealed basket and copies it: buy, vault deposit, USDC kept", async () => {
  const { service, follows, api, swap } = setup({
    assets: [
      asset(8453, 0, NVDA, 5000, "1"),
      asset(4663, 1, VAULT, 2500, "2"),
      asset(8453, 0, USDC, 2500, "3"),
    ],
  });
  // Only strategies with a sealed basket are listed, with their verified record.
  expect(await screen.findByText("+12.50% verified over 2 periods")).toBeVisible();
  expect(screen.getByText("Worst drop 3.00% · 2/3 updates revealed · 7 days delay")).toBeVisible();
  expect(screen.queryByText("Nothing yet")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Open strategy AI chips" }));

  expect(await screen.findByText(/30-day free trial, then \$10\.00 a month/)).toBeVisible();
  expect(screen.getByText("Update 0 · sealed 2026-11-02 · +8.00%")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Start free trial" }));

  expect(await screen.findByLabelText("NVDAc on Base 50%")).toBeVisible();
  expect(screen.getByLabelText("Steakhouse USDG vault 25%")).toBeVisible();
  expect(service.subscribe).toHaveBeenCalledWith(7);
  expect(service.signal).toHaveBeenCalledWith(7, word("a"));
  // The key lives on the phone, and update notifications follow the strategy.
  expect(await follows.load()).toEqual([
    {
      strategyId: 7,
      name: "AI chips",
      subscriberKey: word("a"),
      expiresAt: "2026-12-23T12:00:00Z",
      copiedSeq: null,
    },
  ]);
  expect(api.register).toHaveBeenCalledWith("fcm-token-0123456789", "ios");
  expect(api.follow).toHaveBeenCalledWith(DEVICE, 7);
  expect(screen.queryByRole("button", { name: "Notify me about updates" })).toBeNull();

  fireEvent.changeText(screen.getByLabelText("Amount to invest in USDC"), "100");
  expect(screen.getByText("Buy $50.00 of NVDAc on Base")).toBeVisible();
  expect(screen.getByText("Deposit $25.00 in the Steakhouse USDG vault")).toBeVisible();
  expect(screen.getByText(/Small vault deposits lose much of their value to fees/)).toBeVisible();
  expect(screen.getByText("Keep $25.00 as USDC")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Copy basket" }));

  expect(await screen.findByText("Bought NVDAc. Your copy matches update 2.")).toBeVisible();
  expect(swap.startSwap).toHaveBeenCalledTimes(1);
  expect(swap.startSwap).toHaveBeenCalledWith(NVDA, "50000000", expect.any(String), 8453);
  expect(mockRefresh).toHaveBeenCalled();
  await waitFor(async () => expect((await follows.load())[0]!.copiedSeq).toBe(2));
  expect(screen.getByText("Your copy matches this basket.")).toBeVisible();

  fireEvent.press(
    screen.getByRole("button", { name: "Deposit $25.00 in the Steakhouse USDG vault" }),
  );
  expect(
    await screen.findByText('Earn opened with {"profileId":"robinhood-usdg","amount":"25"}'),
  ).toBeVisible();
});

test("a copy stops at a cancelled buy and continues with only what is left", async () => {
  const { swap } = setup({
    initial: "StrategyDetail",
    assets: [asset(8453, 0, NVDA, 5000, "1"), asset(8453, 0, AAPL, 5000, "2")],
    follows: [
      {
        strategyId: 7,
        name: "AI chips",
        subscriberKey: word("a"),
        expiresAt: "2026-12-23T12:00:00Z",
        copiedSeq: 1,
      },
    ],
    swapPhases: ["COMPLETE", "CANCELLED"],
  });
  // Seq 1 was copied, seq 2 sealed three hours ago.
  expect(await screen.findByText("Your copy is 3 hours behind this basket.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Notify me about updates" })).toBeVisible();
  fireEvent.changeText(screen.getByLabelText("Amount to invest in USDC"), "20");
  expect(screen.getByText(/Each buy is its own confidential swap/)).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Copy basket" }));

  expect(await screen.findByText("Stopped at AAPLc. Not bought yet: AAPLc.")).toBeVisible();
  expect(swap.startSwap.mock.calls.map((call) => call[0])).toEqual([NVDA, AAPL]);
  fireEvent.press(screen.getByRole("button", { name: "Continue copying" }));
  expect(await screen.findByText("Bought NVDAc, AAPLc. Your copy matches update 2.")).toBeVisible();
  expect(swap.startSwap.mock.calls.map((call) => call[0])).toEqual([NVDA, AAPL, AAPL]);
});

test("an open swap blocks copying until it is finished", async () => {
  const { swap } = setup({
    initial: "StrategyDetail",
    assets: [asset(8453, 0, NVDA, 10000, "1")],
    follows: [
      {
        strategyId: 7,
        name: "AI chips",
        subscriberKey: word("a"),
        expiresAt: "2026-12-23T12:00:00Z",
        copiedSeq: null,
      },
    ],
    openSwap: true,
  });
  fireEvent.changeText(await screen.findByLabelText("Amount to invest in USDC"), "10");
  fireEvent.press(screen.getByRole("button", { name: "Copy basket" }));
  expect(
    await screen.findByText("Finish or cancel your open swap in Exchange first, then copy."),
  ).toBeVisible();
  expect(swap.startSwap).not.toHaveBeenCalled();
});

test("an ended trial offers to stop following", async () => {
  const { service, follows } = setup({
    initial: "StrategyDetail",
    assets: [asset(8453, 0, NVDA, 10000, "1")],
    follows: [
      {
        strategyId: 7,
        name: "AI chips",
        subscriberKey: word("a"),
        expiresAt: "2026-11-01T00:00:00Z",
        copiedSeq: null,
      },
    ],
  });
  service.signal.mockRejectedValue(new ApiError(402, "PAYMENT_REQUIRED", "x"));
  fireEvent.press(await screen.findByRole("button", { name: "Stop following" }));
  expect(await screen.findByRole("button", { name: "Start free trial" })).toBeVisible();
  expect(await follows.load()).toEqual([]);
});

test("a notification opens only a strategy this phone follows", async () => {
  const follows = createMemoryFollowStore([
    { strategyId: 7, name: "AI chips", subscriberKey: word("a"), expiresAt: "", copiedSeq: null },
  ]);
  const data = { type: "strategy-update", ref: "7b02db34df72e3ec1deb9beaf3cbe044" };
  expect(await strategyLinkFor(data, follows)).toBeNull();
  await follows.setPushDevice(DEVICE);
  expect(await strategyLinkFor(data, follows)).toBe("gizu://strategy/7");
  expect(await strategyLinkFor({ ...data, ref: "0".repeat(32) }, follows)).toBeNull();
  expect(await strategyLinkFor({ type: "other", ref: data.ref }, follows)).toBeNull();
});
