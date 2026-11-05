import { act, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import { EarnProvider } from "@/features/earn/EarnProvider";
import { DepositJourneyScreen } from "@/features/earn/DepositJourneyScreen";
import type { EarnDepositService, DepositSnapshot } from "@/domain/earn/depositJourney";
import { depositSnapshot } from "../../support/depositJourney";
import { distributionDepositSnapshot } from "../../support/depositDistribution";
import { parseDepositSnapshot } from "@/domain/earn/depositJourney";
import { hoodIntent } from "../../support/robinhoodEarn";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { deferred } from "../../support/renderApp";
const Stack = createNativeStackNavigator();
function ready(): DepositSnapshot {
  const raw = depositSnapshot();
  raw.review.quotedAtMs = Date.now();
  raw.review.expiresAtMs = Date.now() + 45000;
  return raw as DepositSnapshot;
}
function setup(overrides: Partial<EarnDepositService> = {}, id?: string) {
  const snapshot = ready();
  const service = {
    available: jest.fn().mockResolvedValue(true),
    prepare: jest.fn().mockResolvedValue(snapshot),
    confirm: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    status: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    resume: jest.fn().mockResolvedValue({ ...snapshot, phase: "funding" }),
    cancel: jest.fn().mockResolvedValue({ ...snapshot, phase: "paused", pauseReason: "cancelled" }),
    ...overrides,
  };
  const navigation = createNavigationContainerRef();
  const result = render(
    <MainnetWalletProvider
      session={{
        kind: "mainnet",
        walletId: hoodIntent.walletId,
        address: hoodIntent.sourceAddress,
        accountId: hoodIntent.sourceAddress,
        accountIndex: 1,
        method: "Passkey",
        chainId: 143,
      }}
      service={{
        getMainnetPortfolio: jest
          .fn()
          .mockResolvedValue(mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress)),
      }}
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
            <Stack.Screen name="Other">{() => null}</Stack.Screen>
          </Stack.Navigator>
        </NavigationContainer>
      </EarnProvider>
    </MainnetWalletProvider>,
  );
  return { service, snapshot, navigation, ...result };
}
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
  setup({ available: jest.fn().mockResolvedValue(false) });
  const user = userEvent.setup();
  expect(await screen.findByText(/updated.*native|Update the native app/)).toBeVisible();
  await user.type(screen.getByLabelText("USDC deposit amount"), "3");
  expect(screen.getByRole("button", { name: "Review deposit" })).toBeDisabled();
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
