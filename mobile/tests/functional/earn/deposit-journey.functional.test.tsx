import { AppState, RefreshControl, Text } from "react-native";
import { act, fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { MainnetWalletProvider, useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { EarnProvider } from "@/features/earn/EarnProvider";
import { DepositJourneyScreen } from "@/features/earn/DepositJourneyScreen";
import { VaultPositionScreen } from "@/features/earn/VaultPositionScreen";
import { EarnInvestmentScreen } from "@/features/earn/EarnInvestmentScreen";
import type { RootStackParamList } from "@/navigation/types";
import type { EarnDepositService, DepositSnapshot } from "@/domain/earn/depositJourney";
import { depositSnapshot } from "../../support/depositJourney";
import { distributionDepositSnapshot } from "../../support/depositDistribution";
import { parseDepositSnapshot } from "@/domain/earn/depositJourney";
import { hoodIntent } from "../../support/robinhoodEarn";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { deferred } from "../../support/renderApp";
type TestRoutes = RootStackParamList & { Deposit: undefined; Other: undefined };
const Stack = createNativeStackNavigator<TestRoutes>();
function SharedBalance() {
  const { snapshot } = useMainnetWallet();
  return <Text>Shared USDC: {snapshot?.totalAtoms ?? "unknown"}</Text>;
}
function ready(): DepositSnapshot {
  const raw = depositSnapshot();
  raw.review.quotedAtMs = Date.now();
  raw.review.expiresAtMs = Date.now() + 45000;
  return raw as DepositSnapshot;
}

test("shows the native calculated private amount and public shortfall instead of asking the user to guess", async () => {
  const paused = {
    ...ready(),
    phase: "paused" as const,
    pauseReason: "uneconomicAmount" as const,
    review: undefined,
    message:
      "You can deposit 1.8 USDC from routable private balances before fees. The remaining 0.142172 USDC needs public funding, which requires at least 0.2 USDC. Change the amount to 1.8 USDC and review the fees.",
  };
  setup({ pending: jest.fn().mockResolvedValue(paused) });
  expect(await screen.findByText(paused.message)).toBeVisible();
  expect(screen.queryByText(/Lower it until/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
});

function setup(
  overrides: Partial<EarnDepositService> = {},
  id?: string,
  publicAtoms = "19990574",
  privateAtoms = "0",
  portfolioOverride?: import("@/features/wallet/MainnetWalletProvider").MainnetPortfolioService,
) {
  const snapshot = ready();
  const service = {
    available: jest.fn().mockResolvedValue(true),
    pending: jest.fn().mockResolvedValue(null),
    prepare: jest.fn().mockResolvedValue(snapshot),
    confirm: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    status: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    resume: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    cancel: jest.fn().mockResolvedValue({ ...snapshot, phase: "paused", pauseReason: "cancelled" }),
    ...overrides,
  };
  const portfolio = portfolioOverride ?? {
    getMainnetPortfolio: jest.fn().mockImplementation(async () => ({
      ...mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, publicAtoms),
      ownedAssets: [
        {
          assetId: "private-usdc",
          chainId: 143,
          token: "confidential:monad-usdc",
          symbol: "USDC (private)",
          decimals: 6,
          balanceAtoms: null,
          observedAtoms: privateAtoms,
          complete: false,
          stale: true,
          checkedAt: Date.now(),
          valueUsdcAtoms: null,
          valuationUnavailable: true,
        },
      ],
    })),
  };
  const navigation = createNavigationContainerRef<TestRoutes>();
  const app = (walletId: string) => (
    <MainnetWalletProvider
      session={{
        kind: "mainnet",
        walletId,
        address: hoodIntent.sourceAddress,
        accountId: hoodIntent.sourceAddress,
        accountIndex: 1,
        method: "Passkey",
        chainId: 143,
      }}
      service={portfolio}
    >
      <EarnProvider
        depositJourney={service}
        service={{
          load: jest.fn().mockResolvedValue({ status: "absent" }),
          prepare: jest.fn(),
          cancel: jest.fn(),
        }}
      >
        <NavigationContainer ref={navigation}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Deposit">
              {() => <DepositJourneyScreen profileId="robinhood-usdg" savedJourneyId={id} />}
            </Stack.Screen>
            <Stack.Screen name="Other" component={SharedBalance} />
            <Stack.Screen name="VaultPosition" component={VaultPositionScreen} />
            <Stack.Screen name="EarnInvestment" component={EarnInvestmentScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </EarnProvider>
    </MainnetWalletProvider>
  );
  const result = render(app(hoodIntent.walletId));
  return {
    service,
    snapshot,
    navigation,
    portfolio,
    switchWallet: (walletId: string) => result.rerender(app(walletId)),
    ...result,
  };
}
test("completed deposit opens the invested overview instead of a saved recovery or return workflow", async () => {
  const invested: DepositSnapshot = {
    ...ready(),
    phase: "invested",
    completedSteps: ["funding", "credit", "payouts", "deposit"],
    depositedAtoms: "2498000",
    sharesAtoms: "2490000000000000000",
  };
  const h = setup({ status: jest.fn().mockResolvedValue(invested) }, invested.journeyId);
  await userEvent.press(await screen.findByRole("button", { name: "View investment" }));
  expect(h.navigation.getCurrentRoute()?.name).toBe("VaultPosition");
  expect(h.navigation.getCurrentRoute()?.params).toEqual({ profileId: "robinhood-usdg" });
  expect(await screen.findByText("Your vault position")).toBeVisible();
  expect(screen.queryByText("Return to private balance")).toBeNull();
  expect(screen.queryByRole("button", { name: "Verify private balance" })).toBeNull();
});
test("opening deposit after conversion resumes saved progress instead of requiring fresh USDC", async () => {
  const pending = parseDepositSnapshot(
    {
      ...distributionDepositSnapshot(1),
      phase: "paused",
      pauseReason: "providerUnavailable",
      completedSteps: ["funding", "credit"],
      creditedAtoms: "2970000",
    },
    { walletId: hoodIntent.walletId },
  );
  const { service } = setup(
    {
      pending: jest.fn().mockResolvedValue(pending),
      status: jest.fn().mockResolvedValue(pending),
      resume: jest.fn().mockResolvedValue(pending),
    },
    undefined,
    "90294",
    "35834",
  );
  expect(await screen.findByText("Deposit paused")).toBeVisible();
  expect(screen.queryByLabelText("USDC deposit amount")).toBeNull();
  const resume = screen.getByRole("button", { name: "Review remaining steps" });
  expect(resume).toBeEnabled();
  await userEvent.press(resume);
  expect(service.resume).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    pending.journeyId,
    pending.revision,
  );
  expect(service.prepare).not.toHaveBeenCalled();
});
test("a failed saved-progress lookup blocks a new deposit and can be retried", async () => {
  const pending = jest
    .fn()
    .mockRejectedValueOnce(new Error("Saved progress could not be read"))
    .mockResolvedValueOnce(null);
  const { service } = setup({ pending });
  expect(await screen.findByText("Saved progress could not be read")).toBeVisible();
  expect(screen.queryByLabelText("USDC deposit amount")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Retry saved progress" }));
  expect(await screen.findByLabelText("USDC deposit amount")).toBeVisible();
  expect(pending).toHaveBeenCalledTimes(2);
  expect(service.prepare).not.toHaveBeenCalled();
});
test("an existing legacy review restores its saved budget without reentering the amount", async () => {
  const pending = ready();
  const { service } = setup({ pending: jest.fn().mockResolvedValue(pending) });
  const confirm = await screen.findByRole("button", { name: "Confirm deposit" });
  expect(confirm).toBeEnabled();
  await userEvent.press(confirm);
  expect(service.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    pending.journeyId,
    pending.revision,
  );
  expect(service.prepare).not.toHaveBeenCalled();
});
test("a fee preview failure after conversion keeps the existing remaining review available", async () => {
  const pending = parseDepositSnapshot(
    {
      ...distributionDepositSnapshot(1),
      phase: "paused",
      pauseReason: "previewUnavailable",
      completedSteps: ["funding", "credit"],
      creditedAtoms: "2970000",
    },
    { walletId: hoodIntent.walletId },
  );
  const { service } = setup(
    {
      pending: jest.fn().mockResolvedValue(pending),
      status: jest.fn().mockResolvedValue(pending),
      resume: jest.fn().mockResolvedValue(pending),
    },
    undefined,
    "90294",
    "35834",
  );
  expect(await screen.findByText(/A fresh fee estimate is unavailable/)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Review remaining steps" }));
  expect(service.resume).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    pending.journeyId,
    pending.revision,
  );
  expect(service.prepare).not.toHaveBeenCalled();
});
test("saved-progress discovery hides new funding until checked and rejects late results from another wallet", async () => {
  const old = deferred<DepositSnapshot | null>();
  const pending = jest.fn().mockReturnValueOnce(old.promise).mockResolvedValue(null);
  const view = setup({ pending });
  expect(screen.queryByLabelText("USDC deposit amount")).toBeNull();
  await waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
  view.switchWallet("other_wallet");
  expect(await screen.findByLabelText("USDC deposit amount")).toBeVisible();
  await act(async () =>
    old.resolve({ ...ready(), phase: "paused", pauseReason: "providerUnavailable" }),
  );
  expect(screen.queryByRole("button", { name: "Review remaining steps" })).toBeNull();
  expect(screen.getByLabelText("USDC deposit amount")).toBeVisible();
});
async function review() {
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review deposit" })).toBeDisabled(),
  );
  await user.type(screen.getByLabelText("USDC deposit amount"), "3");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  return user;
}
test.each([1, 2, 5])(
  "reviews every investment wallet in a %i-wallet distribution with one confirmation",
  async (count) => {
    const raw = distributionDepositSnapshot(count);
    raw.review.quotedAtMs = Date.now();
    raw.review.expiresAtMs = Date.now() + 45000;
    const distributed = parseDepositSnapshot(raw, { walletId: hoodIntent.walletId });
    const { service } = setup({ prepare: jest.fn().mockResolvedValue(distributed) });
    const user = await review();
    expect(await screen.findByText(`Investment wallets: ${count}`)).toBeVisible();
    for (const destination of distributed.destinations)
      expect(screen.getByText(destination.address)).toBeVisible();
    expect(screen.queryByText(/USDG held/)).toBeNull();
    expect(screen.queryByText(/10% held/)).toBeNull();
    await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
    expect(service.confirm).toHaveBeenCalledTimes(1);
  },
);
test("changing an unsigned distribution amount explicitly discards its saved draft before preparing a new one", async () => {
  const raw = distributionDepositSnapshot();
  raw.review.quotedAtMs = Date.now();
  raw.review.expiresAtMs = Date.now() + 45000;
  const distributed = parseDepositSnapshot(raw, { walletId: hoodIntent.walletId });
  const discardDraft = jest.fn().mockResolvedValue(undefined);
  const { service } = setup({ prepare: jest.fn().mockResolvedValue(distributed), discardDraft });
  const user = await review();
  expect(screen.getByLabelText("USDC deposit amount")).toBeDisabled();
  await user.press(screen.getByRole("button", { name: "Change amount" }));
  expect(discardDraft).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    distributed.journeyId,
  );
  expect(screen.getByLabelText("USDC deposit amount")).toBeEnabled();
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(jest.mocked(service.prepare).mock.calls.at(-1)?.[3]).toBeUndefined();
});
test("a reopened expired distribution review refreshes using its saved budget", async () => {
  const raw = distributionDepositSnapshot();
  raw.review.quotedAtMs = Date.now() - 50000;
  raw.review.expiresAtMs = Date.now() - 5000;
  const distributed = parseDepositSnapshot(raw, { walletId: hoodIntent.walletId });
  const { service } = setup(
    { status: jest.fn().mockResolvedValue(distributed) },
    distributed.journeyId,
  );
  await userEvent.press(await screen.findByRole("button", { name: "Refresh deposit review" }));
  expect(service.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    "robinhood-usdg",
    "3000000",
    distributed.journeyId,
  );
});
test("amount, unsigned review, one confirm and verified investment have no child or withdrawal controls", async () => {
  const { service, snapshot } = setup();
  const user = await review();
  expect(await screen.findByText("Review deposit")).toBeVisible();
  expect(screen.getByText("Source budget: 3 USDC")).toBeVisible();
  expect(screen.getByText("At least 0.28 USDG held")).toBeVisible();
  expect(screen.getByText("At least 2.495 USDG invested")).toBeVisible();
  expect(screen.getByText("Withdrawal reserve: 0.052 USDG")).toBeVisible();
  expect(service.confirm).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /wallet 1 payout/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  await user.press(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(hoodIntent.destinations[0].address)).toBeVisible();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  expect(await screen.findByText("Converting USDC to private balance")).toBeVisible();
  expect(service.confirm).toHaveBeenCalledTimes(1);
  jest.mocked(service.status).mockResolvedValue({
    ...snapshot,
    phase: "invested",
    revision: 5,
    completedSteps: ["funding", "credit", "payouts", "deposit"],
    creditedAtoms: "2970000",
    holdReceivedAtoms: "290000",
    investReceivedAtoms: "2650000",
    depositedAtoms: "2498000",
    sharesAtoms: "2490000000000000000",
    depositTransactionHash: "0x" + "a".repeat(64),
  });
  await user.press(screen.getByRole("button", { name: "Check progress" }));
  expect(await screen.findByText("Invested")).toBeVisible();
  expect(screen.getByText("0.29 USDG held")).toBeVisible();
  expect(screen.getByText("2.498 USDG invested")).toBeVisible();
});
test("shows the indicative 10/90 split while fees are prepared and cannot confirm it", async () => {
  jest.useFakeTimers();
  const pending = deferred<DepositSnapshot>();
  const partial = {
    ...ready(),
    phase: "preparing",
    review: undefined,
    indicativeReview: {
      quotedAtMs: Date.now(),
      sourceBudgetAtoms: "3000000",
      holdEstimatedAtoms: "290000",
      investEstimatedAtoms: "2650000",
      sourceMaximumFeeAtoms: "10000",
    },
  } as DepositSnapshot;
  const view = setup({
    prepare: jest.fn().mockReturnValue(pending.promise),
    status: jest.fn().mockResolvedValue(partial),
  });
  try {
    const user = await review();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Estimated 10% held: 0.29 USDG")).toBeVisible();
    expect(screen.getByText("Estimated 90% before vault fees: 2.65 USDG")).toBeVisible();
    expect(screen.getByText(/Calculating vault fees and the withdrawal reserve/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
    expect(view.service.confirm).not.toHaveBeenCalled();
    await act(async () => pending.resolve(ready()));
    expect(screen.getByText("At least 2.495 USDG invested")).toBeVisible();
    await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
    expect(view.service.confirm).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    pending.resolve(ready());
    jest.useRealTimers();
  }
});
test("a vault preview failure keeps its preliminary estimate visible without enabling confirmation", async () => {
  jest.useFakeTimers();
  const pending = deferred<DepositSnapshot>();
  const raw = distributionDepositSnapshot(1);
  const partial = {
    ...parseDepositSnapshot(raw, { walletId: hoodIntent.walletId }),
    phase: "preparing",
    review: undefined,
    indicativeReview: {
      quotedAtMs: Date.now(),
      sourceBudgetAtoms: "3000000",
      holdEstimatedAtoms: "0",
      investEstimatedAtoms: "2650000",
      sourceMaximumFeeAtoms: "10000",
    },
  } as DepositSnapshot;
  const view = setup({
    prepare: jest.fn().mockReturnValue(pending.promise),
    status: jest.fn().mockResolvedValue(partial),
  });
  try {
    await review();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Estimated investment before vault fees: 2.65 USDG")).toBeVisible();
    await act(async () =>
      pending.resolve({
        ...partial,
        revision: partial.revision + 1,
        phase: "paused",
        pauseReason: "previewUnavailable",
      }),
    );
    expect(await screen.findByText(/A fresh fee estimate is unavailable/)).toBeVisible();
    expect(screen.getByText("Estimated investment before vault fees: 2.65 USDG")).toBeVisible();
    expect(screen.queryByText(/Calculating vault fees and the withdrawal reserve/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review deposit" })).toBeEnabled();
  } finally {
    view.unmount();
    pending.resolve(partial);
    jest.useRealTimers();
  }
});
test("live credit waiting continues through progress without asking for another approval", async () => {
  jest.useFakeTimers();
  const waiting = { ...ready(), phase: "settlingCredit", revision: 3 } as DepositSnapshot;
  const { service, snapshot, unmount } = setup({
    confirm: jest.fn().mockResolvedValue(waiting),
    status: jest.fn().mockResolvedValue(waiting),
  });
  try {
    const user = await review();
    await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
    expect(await screen.findByText("Deposit in progress")).toBeVisible();
    expect(await screen.findByText("Verifying confidential credit")).toBeVisible();
    expect(
      screen.getByText(/Your deposit continues automatically within your approval limits/),
    ).toBeVisible();
    expect(screen.queryByText("Deposit paused")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review remaining steps" })).toBeNull();
    expect(screen.getByLabelText("Verify confidential credit: In progress")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Verified deposit steps" })).toHaveProp(
      "accessibilityValue",
      { min: 0, max: 4, now: 0 },
    );
    jest.mocked(service.status).mockResolvedValue({
      ...snapshot,
      phase: "invested",
      revision: 4,
      completedSteps: ["funding", "credit", "payouts", "deposit"],
      creditedAtoms: "2970000",
      holdReceivedAtoms: "290000",
      investReceivedAtoms: "2650000",
      depositedAtoms: "2498000",
      sharesAtoms: "2490000000000000000",
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(await screen.findByText("Invested")).toBeVisible();
    expect(service.confirm).toHaveBeenCalledTimes(1);
    expect(service.resume).not.toHaveBeenCalled();
  } finally {
    unmount();
    jest.useRealTimers();
  }
});
test("late preparation cannot authorize an edited amount; the same draft is reused", async () => {
  const pending = deferred<DepositSnapshot>();
  const prepare = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(ready());
  setup({ prepare });
  const user = await review();
  const input = screen.getByLabelText("USDC deposit amount");
  await user.clear(input);
  await user.type(input, "4");
  await act(async () => pending.resolve(ready()));
  expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(prepare).toHaveBeenLastCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "4000000",
    "deposit_1",
  );
});
test("leaving during preparation cancels its native draft before a final review returns", async () => {
  const pending = deferred<DepositSnapshot>();
  const partial = { ...ready(), phase: "preparing", review: undefined } as DepositSnapshot;
  const { service, navigation, unmount } = setup({
    prepare: jest.fn().mockReturnValue(pending.promise),
    status: jest.fn().mockResolvedValue(partial),
  });
  try {
    await review();
    act(() => navigation.navigate("Other" as never));
    await waitFor(() =>
      expect(service.cancel).toHaveBeenCalledWith(expect.anything(), "deposit_1", 1),
    );
    expect(service.confirm).not.toHaveBeenCalled();
  } finally {
    await act(async () => pending.resolve(ready()));
    unmount();
  }
});
test("unavailable preview explains why and never requests signing", async () => {
  const { service } = setup({
    prepare: jest.fn().mockResolvedValue({
      ...ready(),
      phase: "paused",
      pauseReason: "previewUnavailable",
      review: undefined,
    }),
  });
  await review();
  expect(await screen.findByText(/fresh fee estimate is unavailable/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Confirm deposit" })).toBeNull();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("leaving a failed unsigned review preserves its preview failure instead of claiming approval stopped", async () => {
  const failed = {
    ...ready(),
    phase: "paused",
    pauseReason: "previewUnavailable",
    review: undefined,
  } as DepositSnapshot;
  const { service, navigation } = setup({ prepare: jest.fn().mockResolvedValue(failed) });
  await review();
  expect(await screen.findByText(/fresh fee estimate is unavailable/)).toBeVisible();
  act(() => navigation.navigate("Other" as never));
  await act(async () => {});
  act(() => navigation.goBack());
  expect(await screen.findByText(/fresh fee estimate is unavailable/)).toBeVisible();
  expect(screen.queryByText("Approval stopped. Submitted transactions remain tracked.")).toBeNull();
  expect(service.cancel).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("leaving a provider-paused private deposit preserves the failure and remaining review", async () => {
  const paused = {
    ...ready(),
    phase: "paused",
    pauseReason: "providerUnavailable",
    creditedAtoms: "990000",
    completedSteps: ["funding", "credit"],
  } as DepositSnapshot;
  const { service, navigation } = setup(
    { status: jest.fn().mockResolvedValue(paused) },
    paused.journeyId,
  );
  expect(await screen.findByText(/funding provider is unavailable/)).toBeVisible();
  act(() => navigation.navigate("Other" as never));
  await act(async () => {});
  act(() => navigation.goBack());
  expect(await screen.findByText(/funding provider is unavailable/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Review remaining steps" })).toBeEnabled();
  expect(service.cancel).not.toHaveBeenCalled();
});

test("a native read-only passkey transition during review preparation does not cancel the draft", async () => {
  const pending = deferred<DepositSnapshot>();
  const partial = { ...ready(), phase: "preparing", review: undefined } as DepositSnapshot;
  const { service } = setup({
    prepare: jest.fn().mockReturnValue(pending.promise),
    status: jest.fn().mockResolvedValue(partial),
  });
  await review();
  const callbacks = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, callback]) => callback);
  act(() => callbacks.forEach((callback) => callback("background")));
  await act(async () => {});
  expect(service.cancel).not.toHaveBeenCalled();
  act(() => callbacks.forEach((callback) => callback("active")));
  await act(async () => pending.resolve(ready()));
  expect(await screen.findByRole("button", { name: "Confirm deposit" })).toBeEnabled();
  expect(service.cancel).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
});

test("retrying a cancelled unsigned review shows preparation rather than the old cancellation", async () => {
  const cancelled = {
    ...ready(),
    phase: "paused",
    pauseReason: "cancelled",
    review: undefined,
  } as DepositSnapshot;
  const pending = deferred<DepositSnapshot>();
  const prepare = jest.fn().mockResolvedValueOnce(cancelled).mockReturnValueOnce(pending.promise);
  setup({ prepare });
  const user = await review();
  expect(
    await screen.findByText("Approval stopped. Submitted transactions remain tracked."),
  ).toBeVisible();
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(screen.queryByText("Approval stopped. Submitted transactions remain tracked.")).toBeNull();
  expect(screen.getByText("Preparing deposit review")).toBeVisible();
  await act(async () => pending.resolve(ready()));
  expect(await screen.findByRole("button", { name: "Confirm deposit" })).toBeEnabled();
});
test("returning after cancelled preparation can review again using the same draft", async () => {
  const pending = deferred<DepositSnapshot>();
  const partial = { ...ready(), phase: "preparing", review: undefined } as DepositSnapshot;
  const cancelled = {
    ...partial,
    revision: 2,
    phase: "paused",
    pauseReason: "cancelled",
  } as DepositSnapshot;
  const prepare = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(ready());
  const { service, navigation } = setup({
    prepare,
    status: jest.fn().mockResolvedValue(partial),
    cancel: jest.fn().mockResolvedValue(cancelled),
  });
  const user = await review();
  await waitFor(() => expect(service.status).toHaveBeenCalled(), { timeout: 2000 });
  act(() => navigation.navigate("Other" as never));
  await waitFor(() => expect(service.cancel).toHaveBeenCalled());
  await act(async () => pending.resolve(cancelled));
  act(() => navigation.goBack());
  const retry = await screen.findByRole("button", { name: "Review deposit" });
  expect(retry).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Review remaining steps" })).toBeNull();
  await user.press(retry);
  expect(prepare).toHaveBeenLastCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "3000000",
    "deposit_1",
  );
  expect(service.resume).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
});
test("an expired unsigned preparation without a review can be prepared again", async () => {
  const row = {
    ...ready(),
    phase: "paused",
    pauseReason: "approvalExpired",
    review: undefined,
  } as DepositSnapshot;
  const { service } = setup({ status: jest.fn().mockResolvedValue(row) }, "deposit_1");
  await screen.findByText(/Approval ended/);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "3");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(service.prepare).toHaveBeenLastCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "3000000",
    "deposit_1",
  );
  expect(service.resume).not.toHaveBeenCalled();
});
test("saved partially completed deposit resumes rather than allocating another pair", async () => {
  const row = {
    ...ready(),
    phase: "paused",
    pauseReason: "approvalExpired",
    completedSteps: ["funding", "credit"],
    creditedAtoms: "2970000",
  } as DepositSnapshot;
  const { service } = setup({ status: jest.fn().mockResolvedValue(row) }, "deposit_1");
  expect(await screen.findByText(/Approval ended/)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Review remaining steps" }));
  expect(service.resume).toHaveBeenCalledWith(expect.anything(), "deposit_1", 1);
  expect(service.prepare).not.toHaveBeenCalled();
});
test("leaving a running deposit revokes remaining authority while preserving saved identity", async () => {
  const { service, unmount } = setup();
  const user = await review();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  await screen.findByText("Converting USDC to private balance");
  unmount();
  expect(service.cancel).toHaveBeenCalledWith(expect.anything(), "deposit_1", 1);
});

test("quote expiry disables confirmation while retaining the displayed saved limits", async () => {
  jest.useFakeTimers();
  try {
    setup();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await act(async () => {});
    await user.type(screen.getByLabelText("USDC deposit amount"), "3");
    await user.press(screen.getByRole("button", { name: "Review deposit" }));
    await act(async () => {
      jest.advanceTimersByTime(45001);
    });
    expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeDisabled();
    expect(screen.getByText(/review expired or the amount changed/i)).toBeVisible();
  } finally {
    jest.useRealTimers();
  }
});
test("a rejected native authorization retains saved identity and never prepares a second pair", async () => {
  const confirm = jest.fn().mockRejectedValue(new Error("Passkey declined"));
  const { service } = setup({ confirm, status: jest.fn().mockResolvedValue(ready()) });
  const user = await review();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  expect(await screen.findByText("Passkey declined")).toBeVisible();
  expect(service.status).toHaveBeenCalledWith(expect.anything(), "deposit_1");
  expect(service.prepare).toHaveBeenCalledTimes(1);
});
test("duplicate confirmation taps cannot open another native approval", async () => {
  const pending = deferred<DepositSnapshot>();
  const confirm = jest.fn().mockReturnValue(pending.promise);
  setup({ confirm });
  const user = await review();
  const button = screen.getByRole("button", { name: "Confirm deposit" });
  await user.press(button);
  await user.press(button);
  expect(confirm).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ...ready(), phase: "funding" }));
});
test("unsupported native build keeps review disabled", async () => {
  const { service } = setup({ available: jest.fn().mockResolvedValue(false) });
  expect(await screen.findByText(/updated.*native|Update the native app/)).toBeVisible();
  expect(screen.queryByLabelText("USDC deposit amount")).toBeNull();
  expect(screen.queryByRole("button", { name: "Review deposit" })).toBeNull();
  expect(service.prepare).not.toHaveBeenCalled();
});

test("navigating away while the deposit remains mounted revokes its approval", async () => {
  const { service, navigation } = setup();
  const user = await review();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  await screen.findByText("Converting USDC to private balance");
  expect(service.cancel).not.toHaveBeenCalled();
  act(() => navigation.navigate("Other" as never));
  await waitFor(() =>
    expect(service.cancel).toHaveBeenCalledWith(expect.anything(), "deposit_1", 1),
  );
});

test("a saved sponsorship failure identifies gas sponsorship and resumes the same deposit", async () => {
  const row = {
    ...ready(),
    phase: "paused",
    pauseReason: "sponsorshipUnavailable",
  } as DepositSnapshot;
  const { service } = setup({ status: jest.fn().mockResolvedValue(row) }, "deposit_1");
  expect(await screen.findByText(/Gas sponsorship is unavailable/)).toBeVisible();
  expect(screen.queryByText(/Waiting for verified confidential credit/)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Review remaining steps" }));
  expect(service.resume).toHaveBeenCalledWith(expect.anything(), "deposit_1", 1);
  expect(service.prepare).not.toHaveBeenCalled();
});

test("deposit reuses observed public and private USDC without a second funding read", async () => {
  const fundingBalance = jest.fn().mockRejectedValue(new Error("expired read permission"));
  const { service, portfolio, navigation } = setup(
    { fundingBalance },
    undefined,
    "90000",
    "2430000",
  );
  expect(await screen.findByText("Available: 2.52 USDC")).toBeVisible();
  expect(screen.getByText("Private 2.43 USDC · Public 0.09 USDC")).toBeVisible();
  expect(fundingBalance).not.toHaveBeenCalled();
  act(() => navigation.navigate("Other" as never));
  await act(async () => {});
  act(() => navigation.goBack());
  expect(await screen.findByText("Available: 2.52 USDC")).toBeVisible();
  expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(1);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "2");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(service.prepare).toHaveBeenCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "2000000",
    undefined,
  );
  expect(fundingBalance).not.toHaveBeenCalled();
});

test("private-only observed funds can be reviewed while public USDC is empty", async () => {
  const { service } = setup({}, undefined, "0", "5000000");
  expect(await screen.findByText("Available: 5 USDC")).toBeVisible();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "5");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(service.prepare).toHaveBeenCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "5000000",
    undefined,
  );
});

test("returning from another app refreshes the shared balance while keeping the amount visible", async () => {
  const { portfolio } = setup({}, undefined, "90000", "2430000");
  expect(await screen.findByText("Available: 2.52 USDC")).toBeVisible();
  const callbacks = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, callback]) => callback);
  act(() => callbacks.forEach((callback) => callback("background")));
  act(() => callbacks.forEach((callback) => callback("active")));
  await act(async () => {});
  expect(screen.getByText("Available: 2.52 USDC")).toBeVisible();
  expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Retry available balance" })).toBeNull();
});

test("explicit pull-to-refresh updates the shared balance and a failed refresh keeps observations usable", async () => {
  const portfolio = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValueOnce(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "3000000"),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "2000000"),
      ),
  };
  setup({}, undefined, "0", "0", portfolio);
  expect(await screen.findByText("Available: 3 USDC")).toBeVisible();
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  await waitFor(() => expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Available: 3 USDC")).toBeVisible();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "2");
  expect(screen.getByRole("button", { name: "Review deposit" })).toBeEnabled();
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  expect(await screen.findByText("Available: 2 USDC")).toBeVisible();
});

test("a failed review updates observations quietly while an explicit pull shows its refresh indicator", async () => {
  const automatic = deferred<ReturnType<typeof mainnetPortfolio>>();
  const manual = deferred<ReturnType<typeof mainnetPortfolio>>();
  const portfolio = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValueOnce(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "3000000"),
      )
      .mockReturnValueOnce(automatic.promise)
      .mockReturnValueOnce(manual.promise),
  };
  setup(
    {
      prepare: jest.fn().mockResolvedValue({
        ...ready(),
        phase: "paused",
        pauseReason: "previewUnavailable",
        review: undefined,
      }),
    },
    undefined,
    "0",
    "0",
    portfolio,
  );
  await screen.findByText("Available: 3 USDC");
  await review();
  await waitFor(() => expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/A fresh fee estimate is unavailable/)).toBeVisible();
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  await act(async () =>
    automatic.resolve(mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "3000000")),
  );
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  await act(async () =>
    manual.resolve(mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "2000000")),
  );
  expect(await screen.findByText("Available: 2 USDC")).toBeVisible();
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});

test("an unknown display balance does not prevent the user from requesting native review", async () => {
  const portfolio = { getMainnetPortfolio: jest.fn().mockRejectedValue(new Error("offline")) };
  const { service } = setup({}, undefined, "0", "0", portfolio);
  await waitFor(() => expect(service.available).toHaveBeenCalled());
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "1");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(service.prepare).toHaveBeenCalledWith(
    expect.anything(),
    "robinhood-usdg",
    "1000000",
    undefined,
  );
  expect(screen.queryByRole("button", { name: "Retry available balance" })).toBeNull();
});

test("funds moved after review are reported as insufficient and update the shared observation", async () => {
  const paused = {
    ...ready(),
    phase: "paused",
    pauseReason: "insufficientFunds",
  } as DepositSnapshot;
  const portfolio = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValueOnce(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "3000000"),
      )
      .mockResolvedValue(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "1000000"),
      ),
  };
  const { service } = setup(
    { confirm: jest.fn().mockResolvedValue(paused) },
    undefined,
    "0",
    "0",
    portfolio,
  );
  const user = await review();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  expect(await screen.findByText(/available USDC does not cover/)).toBeVisible();
  await waitFor(() => expect(portfolio.getMainnetPortfolio.mock.calls.length).toBeGreaterThan(1));
  expect(service.confirm).toHaveBeenCalledTimes(1);
});

test("private funding review identifies its source without public address or gas reserves", async () => {
  const raw = distributionDepositSnapshot();
  raw.review.quotedAtMs = Date.now();
  raw.review.expiresAtMs = Date.now() + 45000;
  const source = {
    ...raw.review.sources[0]!,
    kind: "private",
    accountIndex: -1,
    address: "",
    budgetAtoms: "2970000",
    amountAtoms: "2970000",
    maximumFeeAtoms: "0",
    retainedAtoms: "0",
  };
  const snapshot = parseDepositSnapshot(
    {
      ...raw,
      budgetAtoms: "2970000",
      review: { ...raw.review, sourceBudgetAtoms: "2970000", sources: [source] },
    },
    { walletId: hoodIntent.walletId },
  );
  setup({ prepare: jest.fn().mockResolvedValue(snapshot) }, undefined, "0", "2970000");
  await screen.findByText("Available: 2.97 USDC");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC deposit amount"), "2.97");
  await user.press(screen.getByRole("button", { name: "Review deposit" }));
  await user.press(await screen.findByRole("button", { name: "Details" }));
  expect(screen.getByText("Private USDC source · 2.97 USDC")).toBeVisible();
  expect(screen.queryByText(hoodIntent.sourceAddress)).toBeNull();
  expect(screen.queryByText(/Budget 2.97 USDC · gas cap/)).toBeNull();
});

test("a deposit action settling after navigation still refreshes its wallet's shared balance", async () => {
  const pending = deferred<DepositSnapshot>();
  const portfolio = {
    getMainnetPortfolio: jest
      .fn()
      .mockResolvedValue(
        mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "3000000"),
      ),
  };
  const { navigation } = setup(
    { confirm: jest.fn().mockReturnValue(pending.promise) },
    undefined,
    "0",
    "0",
    portfolio,
  );
  const user = await review();
  await user.press(screen.getByRole("button", { name: "Confirm deposit" }));
  act(() => navigation.reset({ index: 0, routes: [{ name: "Other" as never }] }));
  expect(await screen.findByText("Shared USDC: 3000000")).toBeVisible();
  portfolio.getMainnetPortfolio.mockResolvedValue(
    mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress, "1000000"),
  );
  await act(async () => pending.resolve({ ...ready(), phase: "paused", pauseReason: "cancelled" }));
  expect(await screen.findByText("Shared USDC: 1000000")).toBeVisible();
});
