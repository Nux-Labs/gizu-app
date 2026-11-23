import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  strategyMetadataHash,
  type StrategyCard,
  type StrategyDetail,
  type StrategyService,
} from "@/domain/strategies";
import type { MainnetPortfolioSnapshot, StrategyTermsInput } from "@/domain/wallet/storedSigner";
import { StrategiesScreen } from "@/features/strategies/StrategiesScreen";
import { StrategyPublishScreen } from "@/features/strategies/StrategyPublishScreen";
import {
  StrategyOwnerContext,
  type StrategyOwnerDeps,
} from "@/features/strategies/useStrategyOwner";
import type { RootStackParamList } from "@/navigation/types";
import { ApiError } from "@/services/http";
import { mainnetPortfolio } from "../../support/mainnetWallet";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW_MS = 1_900_000_000_000;
const DEADLINE = NOW_MS / 1000 + 600;
const word = (digit: string) => `0x${digit.repeat(64)}`;
const signature = `0x${"ab".repeat(64)}1b`;
const addresses = Array.from(
  { length: 32 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
);

const row = {
  complete: true,
  stale: false,
  checkedAt: 1,
  valueUsdcAtoms: null,
  valuationUnavailable: false,
};
const mockWallet = {
  session: { walletId: "wallet-1" },
  snapshot: {
    ...mainnetPortfolio("wallet-1", "0x1111111111111111111111111111111111111111", "1000000"),
    balanceComplete: true,
    ownedAssets: [
      {
        ...row,
        assetId: "nvda",
        chainId: 8453,
        token: NVDA,
        symbol: "NVDAc",
        decimals: 18,
        balanceAtoms: "1",
        observedAtoms: "1",
        valueUsdAtoms: "6000000",
      },
      // Priced but outside the strategy universe: left out and named.
      {
        ...row,
        assetId: "other",
        chainId: 8453,
        token: "0x000000000000000000000000000000000000dEaD",
        symbol: "OTHERc",
        decimals: 18,
        balanceAtoms: "1",
        observedAtoms: "1",
        valueUsdAtoms: "9000000",
      },
    ],
    positions: [
      {
        ...row,
        assetId: "vault",
        chainId: 4663,
        token: VAULT,
        symbol: "vault",
        decimals: 18,
        balanceAtoms: "1",
        observedAtoms: "1",
        valueUsdAtoms: "3000000",
        shareAtoms: "1",
        underlyingAtoms: "3000000",
      },
    ],
  } as unknown as MainnetPortfolioSnapshot,
};
jest.mock("@/features/wallet/MainnetWalletProvider", () => ({
  useMainnetWallet: () => mockWallet,
}));

function card(overrides: Partial<StrategyCard> = {}): StrategyCard {
  return {
    id: 5,
    signer: addresses[0]!,
    name: "AI chips",
    embargoSeconds: 604800,
    monthlyPriceAtoms: "10000000",
    signalPriceAtoms: "500000",
    seats: 20,
    seatsTaken: 3,
    commits: 0,
    revealed: 0,
    broken: false,
    lastCommitAt: null,
    performance: {
      cumulativeReturnBps: null,
      maxDrawdownBps: null,
      closedPeriods: 0,
      complete: true,
    },
    earnedAtoms: "1500000",
    createdAt: "2026-11-23T00:00:00.000Z",
    registry: { chainId: 84532, address: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7" },
    ...overrides,
  };
}
const detail = (overrides: Partial<StrategyCard> = {}): StrategyDetail => ({
  ...card(overrides),
  history: [],
});

function setup(initial: StrategyCard[] = []) {
  let listed = initial;
  const service = {
    list: jest.fn(async () => listed),
    detail: jest.fn(),
    create: jest.fn(async () => {
      listed = [card()];
      return detail();
    }),
    commit: jest.fn(async (_id: number, request: { seq: number }) => {
      listed = listed.map((c) => ({ ...c, commits: request.seq + 1 }));
      return { seq: request.seq, status: "committed" as const, commitTx: word("c") };
    }),
  } satisfies StrategyService;
  const signer = {
    strategyAddresses: jest.fn(async () => addresses),
    // Native code hashes the terms itself; the app checks it agrees.
    createStrategy: jest.fn(
      async (
        _walletId: string,
        _chainId: number,
        _index: number,
        _embargo: number,
        terms: StrategyTermsInput,
      ) => ({ signer: addresses[0]!, metadataHash: strategyMetadataHash(terms), signature }),
    ),
    sealStrategyCommit: jest.fn(async () => ({
      signer: addresses[0]!,
      assetIds: [word("1"), word("2"), word("3")],
      weightsBps: [3000, 6000, 1000],
      commitment: word("c"),
      signature,
      salt: word("5"),
    })),
  };
  const deps: StrategyOwnerDeps = { service, signer: () => signer, now: () => NOW_MS };
  const Stack = createNativeStackNavigator<RootStackParamList>();
  render(
    <SafeAreaProvider>
      <StrategyOwnerContext.Provider value={deps}>
        <NavigationContainer>
          <Stack.Navigator initialRouteName="Strategies" screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Strategies" component={StrategiesScreen} />
            <Stack.Screen name="StrategyPublish" component={StrategyPublishScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </StrategyOwnerContext.Provider>
    </SafeAreaProvider>,
  );
  return { service, signer };
}

const expectedAssets = [
  { chainId: 8453, kind: 0, address: NVDA, weightBps: 6000 },
  { chainId: 4663, kind: 1, address: VAULT, weightBps: 3000 },
  { chainId: 8453, kind: 0, address: BASE_USDC, weightBps: 1000 },
];

test("publishes a strategy from the portfolio's weights, then seals its first basket", async () => {
  const { service, signer } = setup();
  expect(await screen.findByText("You haven't published a strategy yet.")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Publish a strategy" }));

  expect(await screen.findByLabelText("NVDAc weight 60%")).toBeVisible();
  expect(screen.getByLabelText("Steakhouse USDG weight 30%")).toBeVisible();
  expect(screen.getByLabelText("USDC weight 10%")).toBeVisible();
  expect(screen.queryByLabelText(/OTHERc weight/)).toBeNull();
  expect(
    screen.getByText("Not included because strategies don't support them yet: OTHERc."),
  ).toBeVisible();
  expect(screen.getByText(/Never shared: your wallets/)).toBeVisible();
  const publish = screen.getByRole("button", { name: "Publish strategy" });
  expect(publish).toBeDisabled();

  fireEvent.changeText(screen.getByLabelText("Strategy name"), "AI chips");
  expect(screen.getByText("$10.00 a month · $0.50 per agent signal")).toBeVisible();
  fireEvent.press(publish);

  const metadata = {
    name: "AI chips",
    monthlyPriceAtoms: "10000000",
    signalPriceAtoms: "500000",
    seats: 20,
  };
  await waitFor(() => expect(service.commit).toHaveBeenCalled());
  expect(signer.createStrategy).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    604800,
    metadata,
    DEADLINE,
  );
  expect(service.create).toHaveBeenCalledWith({
    signer: addresses[0],
    embargo: 604800,
    metadata,
    deadline: DEADLINE,
    signature,
  });
  expect(signer.sealStrategyCommit).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    5,
    0,
    expectedAssets,
    DEADLINE,
  );
  expect(service.commit).toHaveBeenCalledWith(5, {
    seq: 0,
    assets: expectedAssets,
    assetIds: [word("1"), word("2"), word("3")],
    weightsBps: [3000, 6000, 1000],
    salt: word("5"),
    commitment: word("c"),
    signature,
    deadline: DEADLINE,
  });

  // Back on the list, the new strategy appears with its sealed update.
  expect(await screen.findByLabelText("Strategy AI chips")).toBeVisible();
  expect(screen.getByText(/1 updates sealed/)).toBeVisible();
  expect(screen.getByText("Earned $1.50")).toBeVisible();
});

test("publishing stays off until weights total 100% and the strategy has a name", async () => {
  const { signer } = setup();
  fireEvent.press(await screen.findByRole("button", { name: "Publish a strategy" }));
  fireEvent.changeText(await screen.findByLabelText("Strategy name"), "AI chips");
  const publish = screen.getByRole("button", { name: "Publish strategy" });
  expect(publish).toBeEnabled();

  fireEvent.press(screen.getByRole("button", { name: "Lower NVDAc by 5%" }));
  expect(screen.getByText("Weights add up to 95%; make it 100%.")).toBeVisible();
  expect(publish).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Raise USDC by 5%" }));
  expect(screen.getByLabelText("USDC weight 15%")).toBeVisible();
  expect(publish).toBeEnabled();

  fireEvent.changeText(screen.getByLabelText("Strategy name"), " ");
  expect(publish).toBeDisabled();
  expect(signer.createStrategy).not.toHaveBeenCalled();
});

test("an update seals the next sequence number and explains a busy registry", async () => {
  const { service, signer } = setup([card({ commits: 2 })]);
  service.commit.mockRejectedValueOnce(new ApiError(400, "STRATEGY_COMMIT_PENDING", "unavailable"));
  fireEvent.press(await screen.findByRole("button", { name: "Send update for AI chips" }));
  expect(await screen.findByText("Update AI chips")).toBeVisible();
  expect(screen.queryByLabelText("Strategy name")).toBeNull();

  fireEvent.press(screen.getByRole("button", { name: "Seal and send update" }));
  expect(
    await screen.findByText("Your previous update is still being sealed. Try again in a minute."),
  ).toBeVisible();
  expect(signer.sealStrategyCommit).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    5,
    2,
    expectedAssets,
    DEADLINE,
  );

  fireEvent.press(screen.getByRole("button", { name: "Seal and send update" }));
  expect(await screen.findByLabelText("Strategy AI chips")).toBeVisible();
  expect(service.commit).toHaveBeenLastCalledWith(5, expect.objectContaining({ seq: 2 }));
});

test("a cancelled first basket switches to sealing that strategy, never publishing another", async () => {
  const { service, signer } = setup();
  signer.sealStrategyCommit.mockRejectedValueOnce(new Error("Wallet operation cancelled."));
  fireEvent.press(await screen.findByRole("button", { name: "Publish a strategy" }));
  fireEvent.changeText(await screen.findByLabelText("Strategy name"), "AI chips");
  fireEvent.press(screen.getByRole("button", { name: "Publish strategy" }));
  expect(
    await screen.findByText(
      "Your strategy is published, but its first basket wasn't sealed: Wallet operation cancelled. Seal it below.",
    ),
  ).toBeVisible();
  expect(service.create).toHaveBeenCalledTimes(1);
  expect(service.commit).not.toHaveBeenCalled();

  // The screen now updates the published strategy; there is no way to publish a second one.
  expect(await screen.findByText("Update AI chips")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Publish strategy" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Seal and send update" }));
  expect(await screen.findByLabelText("Strategy AI chips")).toBeVisible();
  expect(signer.createStrategy).toHaveBeenCalledTimes(1);
  expect(service.commit).toHaveBeenCalledWith(5, expect.objectContaining({ seq: 0 }));
});

test("a create that timed out but landed is found instead of signed again", async () => {
  const { service, signer } = setup();
  // The API finishes creating the strategy, but the response never reaches the phone.
  const created = service.create.getMockImplementation()!;
  service.create.mockImplementationOnce(async () => {
    await created();
    throw new TypeError("Network request failed");
  });
  fireEvent.press(await screen.findByRole("button", { name: "Publish a strategy" }));
  fireEvent.changeText(await screen.findByLabelText("Strategy name"), "AI chips");
  fireEvent.press(screen.getByRole("button", { name: "Publish strategy" }));
  await waitFor(() =>
    expect(service.commit).toHaveBeenCalledWith(5, expect.objectContaining({ seq: 0 })),
  );
  expect(service.list).toHaveBeenCalledWith([addresses[0]]);
  expect(signer.createStrategy).toHaveBeenCalledTimes(1);
});

test("a wallet that hashes the terms differently stops before anything is published", async () => {
  const { service, signer } = setup();
  signer.createStrategy.mockResolvedValueOnce({
    signer: addresses[0]!,
    metadataHash: word("e"),
    signature,
  });
  fireEvent.press(await screen.findByRole("button", { name: "Publish a strategy" }));
  fireEvent.changeText(await screen.findByLabelText("Strategy name"), "AI chips");
  fireEvent.press(screen.getByRole("button", { name: "Publish strategy" }));
  expect(
    await screen.findByText("The app and the wallet disagree on these terms. Update the app."),
  ).toBeVisible();
  expect(service.create).not.toHaveBeenCalled();
});
