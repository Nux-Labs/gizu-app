import * as nativeBridge from "@/services/wallet/nativeBridge";
import { openEarnLink } from "../../support/earnNavigation";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import { defaultPreferences } from "@/domain/preferences";
import { deferred } from "../../support/renderApp";
import { opportunityDetail } from "../../support/opportunities";
import { earnProfiles } from "@/domain/earn/types";
import type { OpportunityDetail } from "@/domain/opportunities";
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
beforeEach(() => {
  // Discovery replaces holdings only after a successful empty native balance read.
  jest.spyOn(nativeBridge, "getStoredSwapSigner").mockReturnValue({
    getSwapHoldings: jest.fn().mockResolvedValue({
      checkedAt: 1_790_000_000_000,
      block: "0x123",
      holdings: [],
    }),
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSwapSigner>>);
});

const address = "0x" + "1".repeat(40);
const intent = {
  status: "prepared" as const,
  version: "gizu-earn-v1" as const,
  walletId,
  intentId: `earn-v1:${walletId}:ethereum-usdc`,
  profileId: "ethereum-usdc" as const,
  sourceAddress: address,
  confidentialAddress: "0x" + "4".repeat(40),
  sourceChainId: 143 as const,
  backupCovered: true as const,
  destinations: [
    { role: "hold" as const, address: "0x" + "2".repeat(40), chainId: 1 as const },
    { role: "invest" as const, address: "0x" + "3".repeat(40), chainId: 1 as const },
  ] as [
    import("@/domain/earn/types").EarnDestination,
    import("@/domain/earn/types").EarnDestination,
  ],
};
const distributionIntent = {
  ...intent,
  version: "gizu-earn-v2" as const,
  cycleIndex: 1,
  intentId: `earn-v2:${walletId}:ethereum-usdc:1`,
  distribution: { version: 1 as const, weightsBps: [10000] },
  distributionBudgetAtoms: "3000000",
  investmentSlot: 0,
  destinations: [{ ...intent.destinations[1], role: "invest" as const, slot: 0 }] as [
    (typeof intent.destinations)[0],
  ],
};
beforeEach(() => {
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener");
});
afterEach(() => jest.restoreAllMocks());
function setup(catalog?: OpportunityDetail) {
  const ready = {
    status: "ready",
    walletId,
    accounts: [{ accountIndex: 0, address, chainId: 10143 }],
  };
  const access = {
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: address }),
    getWalletState: jest.fn().mockResolvedValue(ready),
    openWallet: jest.fn().mockResolvedValue(ready),
    createWallet: jest.fn(),
    backupWallet: jest.fn(),
    restoreWallet: jest.fn(),
    lock: jest.fn(),
  };
  const earn = {
    load: jest.fn().mockResolvedValue({ status: "absent" }),
    prepare: jest.fn().mockResolvedValue(intent),
    prepareDistribution:
      catalog?.chainId === 1 ? jest.fn().mockResolvedValue(distributionIntent) : undefined,
    cancel: jest.fn(),
  };
  const privateBalance = {
    read: jest.fn().mockResolvedValue({
      confidentialAddress: intent.confidentialAddress,
      assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
      available: "1234567",
      timestampMs: Date.now(),
      authenticated: true,
      operationScoped: false,
    }),
    cancel: jest.fn(),
  };
  const preflight = {
    check: jest
      .fn()
      .mockResolvedValue({ ...importFixturePreflight(), owner: intent.destinations[1].address }),
  };
  render(
    <AppRoot
      mainnetPortfolioService={{
        getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio(walletId, address)),
      }}
      accessService={createStoredWalletAccess(() => access)}
      earnWalletService={earn}
      earnPreflightService={preflight}
      earnPrivateBalanceService={privateBalance}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("19990574") }}
      walletTransferService={{ history: jest.fn(), send: jest.fn(), cancel: jest.fn() }}
      opportunityService={{
        list: jest.fn().mockResolvedValue({
          list: catalog ? [catalog] : [],
          page: 0,
          items: 8,
          total: catalog ? 1 : 0,
        }),
        detail: jest.fn().mockResolvedValue(catalog),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
      accountDependencies={{
        clipboard: { copy: jest.fn() },
        store: {
          load: jest.fn().mockResolvedValue(defaultPreferences),
          save: jest.fn(),
          clear: jest.fn(),
        },
      }}
    />,
  );
  return { earn, access, preflight, privateBalance };
}
function importFixturePreflight() {
  return {
    profileId: "ethereum-usdc",
    chainId: 1,
    owner: intent.destinations[1].address,
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    vault: "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
    tokenDecimals: 6,
    blockNumber: "256",
    blockHash: "0x" + "a".repeat(64),
    timestampMs: Date.now(),
    tokenBalance: "0",
    nativeBalance: "0",
    shares: "0",
    newCycleReady: true,
    blockGas: { baseFee: "100", gasUsed: "100", gasLimit: "200" },
    feeHistoryReward: Array(8).fill("1"),
    readOnly: true,
    executionAvailable: false,
    simulationAvailable: false,
  };
}
test("checks the selected vault using only wallet 2 and keeps spending disabled", async () => {
  const { preflight } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Prepare earn wallets" }));
  await userEvent.press(await screen.findByRole("button", { name: "Check vault readiness" }));
  expect(await screen.findByText("Vault asset verified · USDC")).toBeVisible();
  expect(preflight.check).toHaveBeenCalledWith(
    "ethereum-usdc",
    intent.destinations[1].address,
    expect.anything(),
  );
  expect(screen.getByRole("button", { name: "Review investment" })).toBeDisabled();
});
async function open() {
  await screen.findByRole("button", { name: "Unlock wallet" });
  await userEvent.press(screen.getByRole("button", { name: "Unlock wallet" }));
  await openEarnLink();
}
test("wallets are created only after explicit intent and retained on reopening", async () => {
  const { earn } = setup();
  await open();
  expect(await screen.findByText("Source balance: 19.990574 USDC")).toBeVisible();
  expect(earn.prepare).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Prepare earn wallets" }));
  expect(earn.prepare).toHaveBeenCalledWith({ walletId, address }, "ethereum-usdc");
  expect(await screen.findByText("Wallet 1 · Hold 10%")).toBeVisible();
  expect(screen.getByText(intent.destinations[1].address)).toBeVisible();
  expect(screen.getByText(/withdrawal and return need a separate user request/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Review investment" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await openEarnLink();
  expect(await screen.findByText(intent.destinations[0].address)).toBeVisible();
  expect(earn.prepare).toHaveBeenCalledTimes(1);
});
test("double submission is disabled during the native passkey ceremony", async () => {
  const { earn } = setup();
  const result = deferred<typeof intent>();
  earn.prepare.mockReturnValueOnce(result.promise);
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Prepare earn wallets" }));
  expect(screen.getByRole("button", { name: "Preparing wallets…" })).toBeDisabled();
  expect(earn.prepare).toHaveBeenCalledTimes(1);
  await act(async () => result.resolve(intent));
  expect(await screen.findByText("Wallet 2 · Invest 90%")).toBeVisible();
});
test("rejection checks persisted intent before offering a retry", async () => {
  const { earn } = setup();
  earn.prepare.mockRejectedValueOnce(new Error("Passkey cancelled."));
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Prepare earn wallets" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Passkey cancelled.");
  expect(earn.load).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Prepare earn wallets" })).toBeEnabled();
});
test("restored intent remains blocked and the profile cannot silently change", async () => {
  const { earn } = setup();
  earn.load.mockResolvedValueOnce({ ...intent, status: "recoveryRequired" });
  await open();
  expect(
    await screen.findByText(/Recovered wallets require activity reconciliation/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Review investment" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Prepare earn wallets" })).toBeNull();
  expect(earn.prepare).not.toHaveBeenCalled();
});

test("shows an authenticated private balance without claiming settlement or enabling spend", async () => {
  const { privateBalance } = setup();
  await open();
  const user = userEvent.setup();
  await user.press(screen.getByRole("button", { name: "Prepare earn wallets" }));
  await screen.findByText("Wallet 1 · Hold 10%");
  await user.press(screen.getByRole("button", { name: "Check confidential balance" }));
  await screen.findByText("Authenticated private balance: 1.234567 USDC");
  expect(privateBalance.read).toHaveBeenCalledWith(intent);
  expect(screen.getByText(/does not confirm credit/)).toBeOnTheScreen();
  expect(screen.getByRole("button", { name: "Review investment" })).toBeDisabled();
});

test("prepared earn wallets never expose or request a hosted joint routing preview", async () => {
  const fetchBoundary = jest
    .spyOn(global, "fetch")
    .mockRejectedValue(new Error("Unexpected hosted request"));
  const { preflight, privateBalance } = setup();
  await open();
  await userEvent.press(screen.getByRole("button", { name: "Prepare earn wallets" }));
  await screen.findByText("Wallet 1 · Hold 10%");
  expect(screen.queryByRole("button", { name: "Preview routing" })).toBeNull();
  expect(screen.queryByLabelText("USDC routing amount")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Check vault readiness" }));
  await screen.findByText("Vault asset verified · USDC");
  await userEvent.press(screen.getByRole("button", { name: "Check confidential balance" }));
  await screen.findByText("Authenticated private balance: 1.234567 USDC");
  expect(preflight.check).toHaveBeenCalledWith(
    "ethereum-usdc",
    intent.destinations[1].address,
    expect.anything(),
  );
  expect(privateBalance.read).toHaveBeenCalledWith(intent);
  expect(fetchBoundary).not.toHaveBeenCalled();
});
test("leaving the screen cancels private authentication and ignores late results", async () => {
  const { privateBalance } = setup();
  const result = deferred<unknown>();
  privateBalance.read.mockReturnValueOnce(result.promise);
  await open();
  await userEvent.press(screen.getByRole("button", { name: "Prepare earn wallets" }));
  await userEvent.press(await screen.findByRole("button", { name: "Check confidential balance" }));
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(privateBalance.cancel).toHaveBeenCalledTimes(1);
  await act(async () =>
    result.resolve({ confidentialAddress: intent.confidentialAddress, available: "9999999" }),
  );
  await openEarnLink();
  expect(screen.queryByText(/Authenticated private balance:/)).toBeNull();
});

test("a new Earn cycle retains the previous pair and selecting it remounts that cycle's screens", async () => {
  const { earn } = setup();
  const next = {
    ...intent,
    version: "gizu-earn-v2" as const,
    cycleIndex: 1,
    intentId: `earn-v2:${walletId}:ethereum-usdc:1`,
    confidentialAddress: "0x" + "7".repeat(40),
    destinations: [
      { role: "hold" as const, address: "0x" + "8".repeat(40), chainId: 1 as const },
      { role: "invest" as const, address: "0x" + "9".repeat(40), chainId: 1 as const },
    ] as typeof intent.destinations,
  };
  const cycles = {
    list: jest.fn().mockResolvedValue([intent]),
    prepareNew: jest.fn().mockResolvedValue(next),
    select: jest.fn().mockResolvedValue(intent),
  };
  Object.assign(earn, cycles);
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Prepare earn wallets" }));
  cycles.list.mockResolvedValue([intent, next]);
  await userEvent.press(
    await screen.findByRole("button", { name: "Start new Ethereum · Pendle cycle" }),
  );
  expect(cycles.prepareNew).toHaveBeenCalledWith({ walletId, address }, "ethereum-usdc");
  expect(await screen.findByText(next.destinations[0].address)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Open Ethereum · Pendle cycle 0" }));
  expect(cycles.select).toHaveBeenCalledWith({ walletId, address }, intent.intentId);
  expect(await screen.findByText(intent.destinations[0].address)).toBeVisible();
  expect(earn.prepare).toHaveBeenCalledTimes(1);
});

test("catalog Deposit uses the exact supported vault and allocates only after explicit intent", async () => {
  const vault = {
    ...opportunityDetail(1),
    chainId: 1,
    vaultAddress: earnProfiles["ethereum-usdc"].vault,
  };
  const { earn } = setup(vault);
  await screen.findByRole("button", { name: "Unlock wallet" });
  await userEvent.press(screen.getByRole("button", { name: "Unlock wallet" }));
  await userEvent.press(await screen.findByRole("button", { name: `View ${vault.name}` }));
  await userEvent.press(await screen.findByRole("button", { name: "Deposit" }));
  expect(await screen.findByText("Ethereum · Pendle")).toBeVisible();
  expect(earn.prepare).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("USDC deposit amount"), "3");
  await userEvent.press(screen.getByRole("button", { name: "Prepare deposit wallets" }));
  expect(await screen.findByText("Pendle USDC")).toBeVisible();
  expect(earn.prepareDistribution).toHaveBeenCalledWith(
    { walletId, address },
    "ethereum-usdc",
    "3000000",
  );
  expect(earn.prepare).not.toHaveBeenCalled();
});

test("catalog Deposit starts a fresh cycle rather than reusing an existing investment", async () => {
  const vault = {
    ...opportunityDetail(1),
    chainId: 1,
    vaultAddress: earnProfiles["ethereum-usdc"].vault,
  };
  const { earn } = setup(vault);
  earn.load.mockResolvedValue(intent);
  const next = {
    ...distributionIntent,
    version: "gizu-earn-v2" as const,
    cycleIndex: 1,
    intentId: `earn-v2:${walletId}:ethereum-usdc:1`,
  };
  const pending = deferred<typeof next>();
  const prepareDistribution = jest.fn().mockReturnValue(pending.promise);
  Object.assign(earn, { prepareDistribution });
  await screen.findByRole("button", { name: "Unlock wallet" });
  await userEvent.press(screen.getByRole("button", { name: "Unlock wallet" }));
  await userEvent.press(await screen.findByRole("button", { name: `View ${vault.name}` }));
  await userEvent.press(await screen.findByRole("button", { name: "Deposit" }));
  await userEvent.type(await screen.findByLabelText("USDC deposit amount"), "3");
  await userEvent.press(await screen.findByRole("button", { name: "Prepare deposit wallets" }));
  expect(screen.queryByText("Wallet 1 · Hold 10%")).toBeNull();
  expect(screen.getByRole("button", { name: "Prepare deposit wallets" })).toBeDisabled();
  expect(prepareDistribution).toHaveBeenCalledWith(
    { walletId, address },
    "ethereum-usdc",
    "3000000",
  );
  await act(async () => pending.resolve(next));
  expect(await screen.findByText("Pendle USDC")).toBeVisible();
  expect(earn.prepare).not.toHaveBeenCalled();
});

test("USDG vault Deposit opens the Robinhood native flow", async () => {
  jest.spyOn(nativeBridge, "getStoredEarnDepositSigner").mockReturnValue({
    findEarnDeposit: jest.fn().mockResolvedValue(null),
    readEarnDepositFundingBalance: jest.fn().mockResolvedValue(null),
    prepareEarnDeposit: jest.fn(),
    confirmEarnDeposit: jest.fn(),
    getEarnDepositStatus: jest.fn(),
    resumeEarnDeposit: jest.fn(),
    cancelEarnDeposit: jest.fn(),
  });
  const vault = {
    ...opportunityDetail(1),
    name: "Steakhouse USDG",
    chainId: 4663,
    chain: { name: "Robinhood" },
    vaultAddress: earnProfiles["robinhood-usdg"].vault,
  };
  const { earn } = setup(vault);
  await userEvent.press(await screen.findByRole("button", { name: "Unlock wallet" }));
  await userEvent.press(await screen.findByRole("button", { name: `View ${vault.name}` }));
  await userEvent.press(await screen.findByRole("button", { name: "Deposit" }));
  expect(await screen.findByLabelText("USDC deposit amount")).toBeVisible();
  expect(earn.prepare).not.toHaveBeenCalled();
  expect(screen.queryByText(/Deposits to this vault are not available/)).toBeNull();
});
