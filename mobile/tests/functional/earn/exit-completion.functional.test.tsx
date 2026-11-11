import { openEarnLink } from "../../support/earnNavigation";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { render, screen, userEvent } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import { parseRobinhoodPlan, type RobinhoodKind } from "@/domain/earn/robinhoodExecution";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
import { exitSnapshot, returnRow, minimumReturnRow } from "../../support/exitCompletion";
import { parseSponsoredOperations } from "@/domain/earn/sourceFunding";
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
function setup(saved: SponsoredOperation[] = [], available = true, privateAtoms = "0") {
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
  const portfolio = mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress);
  portfolio.ownedAssets = [
    {
      assetId: "private-usdc",
      chainId: 143,
      token: "confidential:monad-usdc",
      symbol: "USDC (private)",
      decimals: 6,
      balanceAtoms: privateAtoms,
      observedAtoms: privateAtoms,
      valueUsdcAtoms: privateAtoms,
      checkedAt: Date.now(),
      complete: true,
      stale: false,
      valuationUnavailable: false,
    },
  ];
  render(
    <AppRoot
      mainnetPortfolioService={{
        getMainnetPortfolio: jest.fn().mockResolvedValue(portfolio),
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
test("real AppRoot explicit exit check uses injected refreshed native return journal and clears completion after reorg", async () => {
  const service = setup([operation("hoodRedeemAll", "withdrawn"), returnRow()]);
  const fetcher = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => ({ ok: true, json: async () => exitSnapshot(Date.now()) }) as Response,
    );
  await open();
  const button = await screen.findByRole("button", { name: "Check exit completion" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(service.execute).not.toHaveBeenCalled();
  await userEvent.press(button);
  expect(await screen.findByText(/Investment exit complete:/)).toBeVisible();
  expect(service.list).toHaveBeenCalledTimes(2);
  const sent = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
  expect(Object.keys(sent).sort()).toEqual(["owner", "profileId"]);
  expect(sent.owner).toBe(hoodIntent.destinations[1].address);
  service.list.mockResolvedValueOnce([{ ...returnRow(), status: "pending", blocked: true }]);
  await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText("Saved native progress must be reconciled.")).toBeVisible();
  expect(screen.queryByText(/Investment exit complete:/)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(service.execute).not.toHaveBeenCalled();
});
test("real AppRoot reports dust and zero-share failure only after explicit read-only check", async () => {
  setup([operation("hoodRedeemAll", "withdrawn"), returnRow()]);
  let shares = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const value = exitSnapshot(Date.now());
    value.balances.tokenAtoms = shares ? "100000" : "500000";
    value.balances.shares = shares ? "1" : "0";
    value.residualUsdcAtoms = shares ? "100000" : "500000";
    value.publicResidualReady = false;
    return { ok: true, json: async () => value } as Response;
  });
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText(/Investment exit incomplete:/)).toBeVisible();
  expect(screen.getByText("Current residual value: 0.5 USDC")).toBeVisible();
  shares = true;
  await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText("Current residual value: 0.1 USDC")).toBeVisible();
  expect(screen.getByText(/Investment exit incomplete:/)).toBeVisible();
});

test("pending return confirms a minimum and exit rechecks native evidence without claiming an exact amount", async () => {
  const pending = {
    ...returnRow(),
    status: "awaitingSettlement" as const,
    creditedAtoms: undefined,
  };
  const service = setup([operation("hoodRedeemAll", "withdrawn"), pending], true, "5000000");
  const confirmed = parseSponsoredOperations([minimumReturnRow()], hoodIntent)[0]!;
  service.reconcileCredit.mockResolvedValueOnce(confirmed);
  const fetcher = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => ({ ok: true, json: async () => exitSnapshot(Date.now()) }) as Response,
    );
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
  expect(
    await screen.findByText("Every submitted return needs authenticated operation credit."),
  ).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Check USDG return credit" }));
  expect(await screen.findByText("At least 0.899 USDC verified")).toBeVisible();
  expect(
    screen.getByText("Your full private balance is checked separately and includes any surplus."),
  ).toBeVisible();
  expect(screen.queryByText(/Confirmed return credit:/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Check USDG return credit" })).toBeNull();
  // A displayed confirmation alone cannot complete exit: the service must reread native evidence.
  await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
  expect(
    await screen.findByText("Every submitted return needs authenticated operation credit."),
  ).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  service.list.mockResolvedValue([operation("hoodRedeemAll", "withdrawn"), confirmed]);
  await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText(/Investment exit complete:/)).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(service.list).toHaveBeenCalledTimes(4);
  expect(service.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  // The independent native portfolio includes all private cash, including surplus,
  // once. A minimum receipt neither replaces it nor adds another portfolio credit.
  expect(await screen.findByLabelText("24.990574 USD")).toBeVisible();
});

test.each(["wrong-kind", "malformed"])(
  "%s minimum evidence leaves the return pending and recoverable",
  async (problem) => {
    const pending = {
      ...returnRow(),
      status: "awaitingSettlement" as const,
      creditedAtoms: undefined,
    };
    const service = setup([operation("hoodRedeemAll", "withdrawn"), pending]);
    const row = minimumReturnRow();
    const invalid =
      problem === "wrong-kind"
        ? { ...row, kind: "hoodDeposit" }
        : {
            ...row,
            minimumReturnReceipt: { ...row.minimumReturnReceipt, spendingAuthorized: true },
          };
    service.reconcileCredit.mockImplementationOnce(
      async () => parseSponsoredOperations([invalid], hoodIntent)[0]!,
    );
    const fetcher = jest.spyOn(globalThis, "fetch");
    await open();
    await userEvent.press(await screen.findByRole("button", { name: "Check USDG return credit" }));
    expect(await screen.findByText("Invalid native minimum return evidence.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check USDG return credit" })).toBeEnabled();
    expect(screen.queryByText(/At least .* USDC verified/)).toBeNull();
    await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
    expect(
      await screen.findByText("Every submitted return needs authenticated operation credit."),
    ).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.execute).not.toHaveBeenCalled();
  },
);
