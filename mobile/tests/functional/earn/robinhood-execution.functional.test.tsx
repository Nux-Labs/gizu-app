import { openEarnLink } from "../../support/earnNavigation";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { render, screen, userEvent, act } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import { parseRobinhoodPlan, type RobinhoodKind } from "@/domain/earn/robinhoodExecution";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
import { deferred } from "../../support/renderApp";
function operation(
  kind: RobinhoodKind = "hoodDeposit",
  status: SponsoredOperation["status"] = "invested",
): SponsoredOperation {
  return {
    operationId: `hood_${kind}`,
    walletId: hoodIntent.walletId,
    revision: 3,
    kind,
    chainId: 4663,
    from: hoodIntent.destinations[1].address,
    amountAtoms:
      kind === "hoodDeposit"
        ? "937500"
        : kind === "hoodRedeemAll"
          ? "800000000000000000"
          : "989500",
    nonce: "0x2",
    blocked: status === "pending",
    canResume: false,
    status,
    ...(status === "pending" ? { userOperationHash: "0x" + "a".repeat(64) } : {}),
    actualTokenFeeAtoms: "10000",
  };
}
function plan(kind: RobinhoodKind) {
  const now = Date.now();
  return parseRobinhoodPlan(
    hoodRaw(kind, now, `hood_${kind}`),
    hoodIntent,
    kind,
    `hood_${kind}`,
    1,
    now,
  );
}
beforeEach(() => {
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener");
});
afterEach(() => jest.restoreAllMocks());
function setup(saved: SponsoredOperation[] = [], available = true) {
  const ready = {
    status: "ready",
    walletId: hoodIntent.walletId,
    accounts: [{ accountIndex: 0, address: hoodIntent.sourceAddress, chainId: 10143 }],
  };
  const access = {
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: hoodIntent.sourceAddress }),
    getWalletState: jest.fn().mockResolvedValue(ready),
    openWallet: jest.fn().mockResolvedValue(ready),
    createWallet: jest.fn(),
    backupWallet: jest.fn(),
    restoreWallet: jest.fn(),
    lock: jest.fn(),
  };
  const service = {
    available: jest.fn().mockResolvedValue(available),
    list: jest.fn().mockResolvedValue(saved),
    plan: jest.fn().mockImplementation(async (_intent, kind: RobinhoodKind) => plan(kind)),
    execute: jest
      .fn()
      .mockImplementation(async (_intent, p) =>
        operation(
          p.kind,
          p.kind === "hoodDeposit"
            ? "invested"
            : p.kind === "hoodRedeemAll"
              ? "withdrawn"
              : "awaitingSettlement",
        ),
      ),
    resume: jest.fn(),
    reconcileCredit: jest.fn().mockResolvedValue({
      ...operation("hoodTokenReturn", "credited"),
      creditedAtoms: "980000",
      transactionHash: "0x" + "b".repeat(64),
    }),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  render(
    <AppRoot
      mainnetPortfolioService={{
        getMainnetPortfolio: jest
          .fn()
          .mockResolvedValue(mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress)),
      }}
      accessService={createStoredWalletAccess(() => access)}
      earnWalletService={{
        load: jest.fn().mockResolvedValue(hoodIntent),
        prepare: jest.fn(),
        cancel: jest.fn(),
      }}
      earnRobinhoodService={service}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("10000000") }}
      walletTransferService={{ history: jest.fn(), send: jest.fn(), cancel: jest.fn() }}
      opportunityService={{
        list: jest.fn().mockResolvedValue({ list: [], page: 0, items: 8, total: 0 }),
        detail: jest.fn(),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
    />,
  );
  return service;
}
async function open() {
  await screen.findByRole("button", { name: "Unlock wallet" });
  await userEvent.press(screen.getByRole("button", { name: "Unlock wallet" }));
  await openEarnLink();
}
test("Hood deposit stops invested; withdrawal and return each require fresh review, native authorization and explicit credit check", async () => {
  const service = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review USDG investment" }));
  expect(await screen.findByText("Withdrawal reserve: 0.052 USDG")).toBeVisible();
  expect(service.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Authorize USDG deposit" }));
  expect(await screen.findByText("USDG remains invested until you withdraw.")).toBeVisible();
  expect(service.plan).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Withdraw USDG investment" }));
  expect(await screen.findByRole("button", { name: "Authorize USDG withdrawal" })).toBeEnabled();
  expect(service.execute).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Authorize USDG withdrawal" }));
  expect(
    await screen.findByText("USDG withdrawal confirmed. Return has not been submitted."),
  ).toBeVisible();
  expect(service.plan).toHaveBeenCalledTimes(2);
  await userEvent.press(screen.getByRole("button", { name: "Review USDG return" }));
  expect(await screen.findByText("Aurora service fee: 2 basis points")).toBeVisible();
  expect(service.execute).toHaveBeenCalledTimes(2);
  await userEvent.press(screen.getByRole("button", { name: "Authorize USDG return" }));
  expect(
    await screen.findByText("USDG sent. Confidential credit is awaiting reconciliation."),
  ).toBeVisible();
  expect(service.reconcileCredit).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Check USDG return credit" }));
  expect(await screen.findByText("Confirmed return credit: 0.98 USDC")).toBeVisible();
  expect(service.execute).toHaveBeenCalledTimes(3);
});
test("unknown submission blocks new actions until saved progress is reconciled", async () => {
  const service = setup([operation("hoodDeposit", "pending")]);
  await open();
  expect(await screen.findByText("USDG submission awaiting reconciliation")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review USDG investment" })).toBeDisabled();
  service.list.mockResolvedValueOnce([operation()]);
  await userEvent.press(screen.getByRole("button", { name: "Check saved USDG progress" }));
  expect(await screen.findByText("USDG remains invested until you withdraw.")).toBeVisible();
  expect(service.execute).not.toHaveBeenCalled();
});
test("remaining shares do not expose a return action", async () => {
  setup([{ ...operation("hoodRedeemAll", "residualShares"), residualShares: "10" }]);
  await open();
  expect(
    await screen.findByText("Shares remain. Review another withdrawal before returning USDG."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review USDG return" })).toBeNull();
});
test("unsupported native builds stay read-only and failed fee reviews never authorize", async () => {
  setup([], false);
  await open();
  expect(
    await screen.findByText(
      "USDG execution requires the updated native signer. This build can review balances only.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Review USDG investment" })).toBeDisabled();
});
test("failed live fees stay review-only and dismissing a valid quote does not sign", async () => {
  const service = setup();
  service.plan.mockRejectedValueOnce(new Error("Live USDG fees unavailable."));
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review USDG investment" }));
  expect(await screen.findByText("Live USDG fees unavailable.")).toBeVisible();
  expect(service.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Review USDG investment" }));
  await userEvent.press(await screen.findByRole("button", { name: "Dismiss USDG review" }));
  expect(screen.queryByRole("button", { name: "Authorize USDG deposit" })).toBeNull();
  expect(service.execute).not.toHaveBeenCalled();
});
test("double native authorization and a late result after closing cannot trigger withdrawal", async () => {
  const service = setup(),
    result = deferred<SponsoredOperation>();
  service.execute.mockReturnValueOnce(result.promise);
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review USDG investment" }));
  await userEvent.press(await screen.findByRole("button", { name: "Authorize USDG deposit" }));
  expect(screen.getByRole("button", { name: "Authorizing USDG…" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(service.cancel).toHaveBeenCalled();
  await act(async () => result.resolve(operation()));
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(service.plan).toHaveBeenCalledTimes(1);
});
