import { openEarnLink } from "../../support/earnNavigation";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { AbortController as NativeAbortController } from "abort-controller";
import { createEarnSourceFundingService } from "@/services/earn/sourceFunding";
import * as nativeBridge from "@/services/wallet/nativeBridge";
import {
  sourceUsdc,
  earnPaymaster,
  earnEntryPoint,
  earnDelegation,
} from "@/domain/earn/sourceFunding";
import { render, screen, userEvent, act } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import type { EarnIntent } from "@/domain/earn/types";
import type { VaultPlan, VaultOperation } from "@/domain/earn/vaultExecution";
import { deferred } from "../../support/renderApp";
import { minimumReturnRow } from "../../support/exitCompletion";
import { parseLiquidityOperations } from "@/domain/earn/ethereumLiquidity";
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
  address = "0x" + "1".repeat(40),
  invest = "0x" + "3".repeat(40);
const intent: EarnIntent & {
  destinations: [EarnIntent["destinations"][0], EarnIntent["destinations"][0]];
} = {
  status: "prepared",
  version: "gizu-earn-v1",
  intentId: "earn-v1:wallet:ethereum-usdc",
  walletId,
  profileId: "ethereum-usdc",
  sourceAddress: address,
  sourceChainId: 143,
  confidentialAddress: "0x" + "4".repeat(40),
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: invest, chainId: 1 },
  ],
};
function plan(kind: "vaultDeposit" | "vaultRedeemAll" = "vaultDeposit"): VaultPlan {
  return {
    kind,
    operationId: "vault_1",
    revision: 1,
    owner: invest,
    amountAtoms: "9950000",
    shareDecimals: 18,
    nonce: 0,
    deadline: Math.floor(Date.now() / 1000) + 600,
    gasLimits: [220000],
    maxFeePerGasWei: "1000000000",
    priorityFeePerGasWei: "10000",
    maximumGasCostWei: "220000000000000",
    withdrawalReserveWei: kind === "vaultDeposit" ? "520000000000000" : "0",
    liquidAtoms: "50000",
    expiresAtMs: Date.now() + 45000,
    fusionRequired: false,
    bootstrapUsdc: "0",
  };
}
function operation(status: VaultOperation["status"] = "invested"): VaultOperation {
  return {
    operationId: "vault_1",
    revision: 3,
    walletId,
    kind: "vaultDeposit",
    from: invest,
    amountAtoms: "9950000",
    actualFeeWei: "195000000000000",
    blocked: status === "pending",
    canResume: false,
    status,
    steps: [
      {
        index: 0,
        to: "0x02912516d49dE997db75B9D7858faAE59209650B",
        nonce: "0",
        status: status === "pending" ? "unknown" : "finalized",
        nonceConflict: false,
        transactionHash: "0x" + "a".repeat(64),
      },
    ],
  };
}
beforeEach(() => {
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener");
});
afterEach(() => jest.restoreAllMocks());
function setup(
  saved: VaultOperation[] = [],
  source?: import("@/domain/earn/sourceFunding").EarnSourceFundingService,
  liquidity?: import("@/domain/earn/ethereumLiquidity").EarnLiquidityService,
  payout?: import("@/domain/earn/privatePayout").EarnPayoutService,
) {
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
  const vault = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue(saved),
    plan: jest.fn().mockResolvedValue(plan()),
    execute: jest.fn().mockResolvedValue(operation()),
    resume: jest.fn().mockResolvedValue(operation()),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  render(
    <AppRoot
      mainnetPortfolioService={{
        getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio(walletId, address)),
      }}
      accessService={createStoredWalletAccess(() => access)}
      earnWalletService={{
        load: jest.fn().mockResolvedValue(intent),
        prepare: jest.fn(),
        cancel: jest.fn(),
      }}
      earnVaultService={vault}
      earnSourceService={source}
      earnLiquidityService={liquidity}
      earnPayoutService={payout}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("10000000") }}
      walletTransferService={{ history: jest.fn(), send: jest.fn(), cancel: jest.fn() }}
      opportunityService={{
        list: jest.fn().mockResolvedValue({ list: [], page: 0, items: 8, total: 0 }),
        detail: jest.fn(),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
    />,
  );
  return vault;
}
async function open() {
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await openEarnLink();
}
test("Earn stops invested; withdrawal is planned and signed only after separate user actions", async () => {
  const vault = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review investment" }));
  expect(await screen.findByText("Withdrawal reserve: 0.00052 ETH")).toBeVisible();
  expect(vault.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Authorize deposit" }));
  expect(await screen.findByText("Funds remain invested until you withdraw.")).toBeVisible();
  expect(vault.plan).toHaveBeenCalledTimes(1);
  expect(vault.execute).toHaveBeenCalledWith(
    intent,
    expect.objectContaining({ kind: "vaultDeposit" }),
  );
  vault.plan.mockResolvedValueOnce(plan("vaultRedeemAll"));
  await userEvent.press(screen.getByRole("button", { name: "Withdraw investment" }));
  expect(await screen.findByRole("button", { name: "Authorize withdrawal" })).toBeEnabled();
  expect(vault.execute).toHaveBeenCalledTimes(1);
  expect(vault.plan).toHaveBeenLastCalledWith(intent, "vaultRedeemAll", expect.anything());
});
test("uncertain saved submission blocks new deposits and reconciles instead of resigning", async () => {
  const vault = setup([operation("pending")]);
  await open();
  expect(await screen.findByText("Submission awaiting reconciliation")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review investment" })).toBeDisabled();
  vault.list.mockResolvedValueOnce([operation()]);
  await userEvent.press(screen.getByRole("button", { name: "Check saved progress" }));
  expect(await screen.findByText("Funds remain invested until you withdraw.")).toBeVisible();
  expect(vault.execute).not.toHaveBeenCalled();
  expect(vault.resume).not.toHaveBeenCalled();
});
test("double authorization is blocked and a late result after leaving cannot start a withdrawal", async () => {
  const vault = setup(),
    result = deferred<VaultOperation>();
  vault.execute.mockReturnValueOnce(result.promise);
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review investment" }));
  await userEvent.press(await screen.findByRole("button", { name: "Authorize deposit" }));
  expect(screen.getByRole("button", { name: "Authorizing…" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(vault.cancel).toHaveBeenCalled();
  await act(async () => result.resolve(operation()));
  expect(vault.plan).toHaveBeenCalledTimes(1);
  expect(vault.execute).toHaveBeenCalledTimes(1);
});

test("source funding reviews USDC gas separately and waits for authenticated credit", async () => {
  const quote = {
    operationId: "source_1",
    revision: 1,
    quoteId: "q1",
    providerFeeBps: 2 as const,
    recipient: "0x" + "5".repeat(40),
    chainId: 143 as const,
    token: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    amountAtoms: "989900",
    confidentialAccount: intent.confidentialAddress,
    refundOwner: address,
    expiresAt: Math.floor(Date.now() / 1000) + 120,
    minimumCreditAtoms: "980000",
  };
  const fundingPlan = {
    quote,
    fees: {
      amount: "989900",
      budget: "1000000",
      feeCap: "100",
      remainingBudget: "10000",
      expiresAtMs: Date.now() + 60000,
      userOperation: { sender: address, nonce: "0x0" },
    },
    budget: "1000000",
    expiresAtMs: Date.now() + 60000,
  };
  const submitted = {
    operationId: "source_1",
    walletId,
    revision: 4,
    kind: "sourceFunding" as const,
    chainId: 143 as const,
    from: address,
    amountAtoms: "989900",
    nonce: "0x0",
    blocked: false,
    canResume: false,
    status: "awaitingSettlement" as const,
    transactionHash: "0x" + "a".repeat(64),
    creditedAtoms: "0",
  };
  const source = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    plan: jest.fn().mockResolvedValue(fundingPlan),
    execute: jest.fn().mockResolvedValue(submitted),
    resume: jest.fn(),
    reconcileCredit: jest.fn().mockResolvedValue({
      ...submitted,
      revision: 5,
      status: "credited",
      creditedAtoms: "985000",
    }),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const vault = setup([], source);
  await open();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("USDC funding budget"), "1");
  await user.press(screen.getByRole("button", { name: "Review USDC funding" }));
  expect(await screen.findByText("Maximum Monad gas: 0.0001 USDC")).toBeVisible();
  expect(source.execute).not.toHaveBeenCalled();
  await user.press(screen.getByRole("button", { name: "Authorize USDC funding" }));
  expect(
    await screen.findByText("USDC sent. Confidential credit is awaiting reconciliation."),
  ).toBeVisible();
  expect(vault.execute).not.toHaveBeenCalled();
  expect(source.reconcileCredit).not.toHaveBeenCalled();
  await user.press(screen.getByRole("button", { name: "Check confidential credit" }));
  expect(await screen.findByText("Confirmed operation credit: 0.985 USDC")).toBeVisible();
  expect(source.execute).toHaveBeenCalledTimes(1);
  expect(vault.plan).not.toHaveBeenCalled();
});

test("ETH funding requires independent permit/order steps and a confirmed fill before fresh deposit review", async () => {
  const proposal = {
    kind: "fusionEthOrder" as const,
    operationId: "fusion_1",
    revision: 1,
    chainId: 1 as const,
    expectedFrom: invest,
    confidentialAccount: intent.confidentialAddress,
    quoteId: "quote_1",
    inputAtoms: "1000000",
    minimumEthWei: "1000000000000000",
    grossEthWei: "1100000000000000",
    maximumResolverOverheadWei: "100000000000000",
    deadline: Math.floor(Date.now() / 1000) + 240,
    fundingMode: "permit" as const,
    unsignedOrder: {},
    extension: "0x1234",
  };
  const row = {
    operationId: "fusion_1",
    walletId,
    revision: 2,
    kind: "fusionEthOrder" as const,
    chainId: 1 as const,
    from: invest,
    amountAtoms: "1000000",
    blocked: true,
    canResume: true,
    status: "permitSaved" as const,
  };
  const liquidity = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    bootstrap: jest.fn().mockResolvedValue({
      proposal,
      expiresAtMs: Date.now() + 60000,
      resolverOverheadWei: "100000000000000",
    }),
    returnPlan: jest.fn(),
    execute: jest.fn().mockResolvedValue(row),
    resume: jest
      .fn()
      .mockResolvedValue({ ...row, revision: 3, status: "pending", canResume: false }),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancelPending: jest.fn(),
    cancel: jest.fn(),
  };
  const vault = setup([], undefined, liquidity);
  vault.plan.mockResolvedValueOnce({
    ...plan(),
    fusionRequired: true,
    bootstrapUsdc: "1000000",
    fusionFunding: {
      minimumEthWei: proposal.minimumEthWei,
      maximumResolverOverheadWei: proposal.maximumResolverOverheadWei,
      resolverGasPriceWei: "1000000000",
    },
  });
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Review investment" }));
  expect(await screen.findByRole("button", { name: "Authorize deposit" })).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Review ETH funding" }));
  expect(await screen.findByRole("button", { name: "Authorize ETH funding" })).toBeEnabled();
  expect(liquidity.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Authorize ETH funding" }));
  expect(
    await screen.findByText(
      "USDC permit saved privately. Review the executable swap order before submission.",
    ),
  ).toBeVisible();
  expect(vault.execute).not.toHaveBeenCalled();
  expect(liquidity.resume).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Review saved liquidity step" }));
  expect(liquidity.resume).toHaveBeenCalledWith(intent, row);
  expect(vault.execute).not.toHaveBeenCalled();
  liquidity.list.mockResolvedValueOnce([
    {
      ...row,
      status: "fusionFilled",
      receivedEthWei: "1000000000000000",
      blocked: false,
      canResume: false,
      revision: 4,
    },
  ]);
  await userEvent.press(screen.getByRole("button", { name: "Check liquidity progress" }));
  expect(
    await screen.findByText(
      "ETH fill verified on-chain. Refresh the investment review to calculate the deposit from current balances.",
    ),
  ).toBeVisible();
  expect(vault.execute).not.toHaveBeenCalled();
  vault.plan.mockResolvedValueOnce(plan());
  await userEvent.press(screen.getByRole("button", { name: "Review investment" }));
  expect(await screen.findByRole("button", { name: "Authorize deposit" })).toBeEnabled();
  expect(screen.getByText("Verified swap input spent: 1 USDC")).toBeVisible();
  expect(screen.getByText("Verified ETH balance increase: 0.001 ETH")).toBeVisible();
  expect(liquidity.returnPlan).not.toHaveBeenCalled();
});

test("authenticated source credit enables independent wallet payouts; pending payout blocks the second leg and never deposits", async () => {
  const funding = {
    operationId: "source_paid",
    walletId,
    revision: 4,
    kind: "sourceFunding" as const,
    chainId: 143 as const,
    from: address,
    amountAtoms: "1000000",
    nonce: "0x0",
    blocked: false,
    canResume: false,
    status: "credited" as const,
    creditedAtoms: "999901",
    transactionHash: "0x" + "a".repeat(64),
  };
  const source = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([funding]),
    plan: jest.fn(),
    execute: jest.fn(),
    resume: jest.fn(),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const pending = {
    operationId: "child_hold",
    walletId,
    revision: 2,
    kind: "confidentialPayout" as const,
    leg: "hold" as const,
    chainId: 1 as const,
    recipient: intent.destinations[0].address,
    amountAtoms: "99990",
    minimumDestinationAtoms: "99000",
    receivedAtoms: "0",
    status: "unknown" as const,
    blocked: true,
    canResume: false,
  };
  const payout = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue(pending),
    resume: jest.fn(),
    reconcile: jest.fn().mockResolvedValue({
      ...pending,
      status: "paid",
      blocked: false,
      revision: 3,
      receivedAtoms: "99100",
      destinationTransactionHash: "0x" + "b".repeat(64),
    }),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const vault = setup([], source, undefined, payout);
  await open();
  expect(
    await screen.findByText(/Confirmed private credit allocation: 0.09999 USDC/),
  ).toBeVisible();
  expect(payout.execute).not.toHaveBeenCalled();
  await userEvent.press(
    screen.getByRole("button", { name: "Review and authorize wallet 1 payout" }),
  );
  expect(await screen.findByRole("button", { name: "Check payout settlement" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Review and authorize wallet 2 payout" }),
  ).toBeDisabled();
  expect(payout.execute).toHaveBeenCalledWith(intent, funding, "hold");
  expect(vault.execute).not.toHaveBeenCalled();
  expect(payout.resume).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Check payout settlement" }));
  expect(await screen.findByText(/Wallet 1 funds remain separate/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Review and authorize wallet 2 payout" }),
  ).toBeEnabled();
  expect(payout.execute).toHaveBeenCalledTimes(1);
  expect(vault.plan).not.toHaveBeenCalled();
});
test("saved pending return needs separate native cancellation approval and stays locked until final reconciliation", async () => {
  const row = {
    operationId: "return_pending",
    walletId,
    revision: 3,
    chainId: 1 as const,
    kind: "returnEth" as const,
    from: invest,
    amountAtoms: "79000",
    status: "unknown" as const,
    transactionHash: "0x" + "a".repeat(64),
    blocked: true,
    canResume: false,
    canCancelPending: true,
  };
  const liquidity = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([row]),
    bootstrap: jest.fn(),
    returnPlan: jest.fn(),
    execute: jest.fn(),
    resume: jest.fn(),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancelPending: jest
      .fn()
      .mockResolvedValue({ ...row, status: "cancellationPending", revision: 4 }),
    cancel: jest.fn(),
  };
  const vault = setup([], undefined, liquidity);
  await open();
  expect(
    await screen.findByRole("button", { name: "Review pending transaction cancellation" }),
  ).toBeEnabled();
  expect(liquidity.cancelPending).not.toHaveBeenCalled();
  await userEvent.press(
    screen.getByRole("button", { name: "Review pending transaction cancellation" }),
  );
  expect(await screen.findByText("ETH return · Cancellation awaiting confirmation")).toBeVisible();
  expect(liquidity.cancelPending).toHaveBeenCalledWith(intent, row);
  expect(liquidity.execute).not.toHaveBeenCalled();
  expect(vault.execute).not.toHaveBeenCalled();
  liquidity.list.mockResolvedValueOnce([
    { ...row, status: "nonceCancelled", blocked: false, revision: 5, canCancelPending: false },
  ]);
  await userEvent.press(screen.getByRole("button", { name: "Check liquidity progress" }));
  expect(await screen.findByText("ETH return · Cancellation confirmed")).toBeVisible();
  expect(liquidity.returnPlan).not.toHaveBeenCalled();
});

test.each(["returnUsdc", "returnEth"] as const)(
  "%s verifies only a minimum and leaves the full private balance independent",
  async (kind) => {
    const confirmed = parseLiquidityOperations(
      [{ ...minimumReturnRow(), kind, chainId: 1 }],
      intent,
    )[0]!;
    const pending = {
      ...confirmed,
      status: "awaitingSettlement" as const,
      verifiedMinimumAtoms: undefined,
      minimumReturnReceipt: undefined,
    };
    const liquidity = {
      available: jest.fn().mockResolvedValue(true),
      list: jest.fn().mockResolvedValue([pending]),
      bootstrap: jest.fn(),
      returnPlan: jest.fn(),
      execute: jest.fn(),
      resume: jest.fn(),
      reconcileCredit: jest.fn().mockResolvedValue(confirmed),
      cancelUnsigned: jest.fn(),
      cancelPending: jest.fn(),
      cancel: jest.fn(),
    };
    setup([], undefined, liquidity);
    await open();
    await userEvent.press(
      await screen.findByRole("button", { name: "Check returned private credit" }),
    );
    expect(await screen.findByText("At least 0.899 USDC verified")).toBeVisible();
    expect(
      screen.getByText("Your full private balance is checked separately and includes any surplus."),
    ).toBeVisible();
    expect(screen.queryByText(/Verified returned credit:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Check returned private credit" })).toBeNull();
    expect(liquidity.execute).not.toHaveBeenCalled();
    expect(liquidity.reconcileCredit).toHaveBeenCalledWith(intent, pending);
  },
);

test("cancelled unsigned payout resumes the same reserved child instead of allocating the role again", async () => {
  const child = {
    operationId: "child_cancelled",
    walletId,
    revision: 4,
    kind: "confidentialPayout" as const,
    leg: "hold" as const,
    chainId: 1 as const,
    recipient: intent.destinations[0].address,
    amountAtoms: "99990",
    minimumDestinationAtoms: "99000",
    receivedAtoms: "0",
    status: "cancelled" as const,
    blocked: false,
    canResume: false,
    canRefreshUnsigned: true,
  };
  const payout = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([child]),
    execute: jest.fn(),
    resume: jest.fn().mockResolvedValue({
      ...child,
      status: "pending",
      blocked: true,
      revision: 6,
      canRefreshUnsigned: false,
    }),
    reconcile: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  setup([], undefined, undefined, payout);
  await open();
  expect(
    await screen.findByRole("button", { name: "Refresh unsigned payout review" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Review and authorize wallet 1 payout" }),
  ).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Refresh unsigned payout review" }));
  expect(payout.resume).toHaveBeenCalledWith(intent, child);
  expect(payout.execute).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Check payout settlement" })).toBeEnabled();
});

test("the funding review button reaches an unsigned fee review with React Native abort signals", async () => {
  const originalAbortController = global.AbortController;
  global.AbortController = NativeAbortController as unknown as typeof AbortController;
  try {
    jest.spyOn(nativeBridge, "getSignerCapabilities").mockResolvedValue({
      contractVersion: 1,
      available: true,
      walletStorage: true,
      backup: true,
      transfers: false,
      swaps: false,
      earnSponsoredExecution: true,
    });
    const recipient = "0x" + "5".repeat(40);
    const native = {
      prepareEarnSourceQuote: jest
        .fn()
        .mockImplementation(async (_wallet, amount, id, revision) => ({
          operationId: id,
          revision,
          quoteId: "q1",
          providerFeeBps: 2,
          recipient,
          chainId: 143,
          token: sourceUsdc,
          amountAtoms: amount,
          confidentialAccount: intent.confidentialAddress,
          refundOwner: address,
          expiresAt: Math.floor(Date.now() / 1000) + 120,
          minimumCreditAtoms: (BigInt(amount) - 100n).toString(),
        })),
      executeEarnSponsored: jest.fn(),
      listEarnSponsoredOperations: jest.fn().mockResolvedValue([]),
      resumeEarnSponsoredOperation: jest.fn(),
      readEarnSponsoredSettlement: jest.fn(),
      cancelEarnSponsoredOperation: jest.fn(),
      lock: jest.fn(),
    };
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          version: "gizu-monad-funding-v1",
          chainId: 143,
          ...request,
          token: sourceUsdc,
          feeCap: "100",
          remainingBudget: (BigInt(request.budget) - BigInt(request.amount) - 100n).toString(),
          entryPoint: earnEntryPoint,
          paymaster: earnPaymaster,
          delegation: earnDelegation,
          authorizationRequired: true,
          authorizationNonce: "0",
          referenceBlock: "100",
          referenceHash: "0x" + "a".repeat(64),
          timestampMs: Date.now(),
          expiresAtMs: Date.now() + 45000,
          paymasterDataStatus: "stub",
          executionAvailable: false,
          operation: {
            sender: address,
            nonce: "0x0",
            callData: "0x1234",
            callGasLimit: "0x1",
            verificationGasLimit: "0x1",
            preVerificationGas: "0x1",
            paymasterVerificationGasLimit: "0x1",
            paymasterPostOpGasLimit: "0x1",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x0",
            paymaster: earnPaymaster,
            paymasterData: "0x1234",
            signature: "0x",
          },
        }),
      } as Response;
    });
    const source = createEarnSourceFundingService("https://backend.test", () => native);
    setup([], source);
    await open();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("USDC funding budget"), "3");
    await user.press(screen.getByRole("button", { name: "Review USDC funding" }));
    expect(await screen.findByText("Source transfer: 2.9899 USDC")).toBeVisible();
    expect(screen.getByText("Maximum Monad gas: 0.0001 USDC")).toBeVisible();
    expect(screen.getByRole("button", { name: "Authorize USDC funding" })).toBeEnabled();
    expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  } finally {
    global.AbortController = originalAbortController;
  }
});

test.each([true, false])(
  "blocked funding displays one unsigned review without invented costs (quote available: %s)",
  async (quoteAvailable) => {
    jest
      .spyOn(nativeBridge, "getSignerCapabilities")
      .mockResolvedValue({ earnSponsoredExecution: true } as Awaited<
        ReturnType<typeof nativeBridge.getSignerCapabilities>
      >);
    const native = {
      prepareEarnSourceQuote: jest.fn().mockRejectedValue(
        Object.assign(new Error("Fee qualification is required."), {
          code: "EARN_AURORA_FEE_UNQUALIFIED",
        }),
      ),
      executeEarnSponsored: jest.fn(),
      listEarnSponsoredOperations: jest.fn().mockResolvedValue([]),
      lock: jest.fn(),
    };
    jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const r = JSON.parse(String(init?.body));
      if (String(url).endsWith("source-preview"))
        return {
          ok: true,
          json: async () => ({
            version: "gizu-source-preview-v1",
            quoteAvailable,
            sourceOwner: address,
            confidentialAccount: intent.confidentialAddress,
            amountAtoms: r.amountAtoms,
            minimumCreditAtoms: quoteAvailable ? "2988704" : null,
            providerFeeBps: quoteAvailable ? 4 : null,
            appFees: quoteAvailable ? [{ recipient: "observed.near", fee: 4 }] : [],
            referral: quoteAvailable ? "observed" : null,
            blockers: [
              "EARN_AURORA_FEE_UNQUALIFIED",
              "EARN_SETTLEMENT_UNQUALIFIED",
              ...(quoteAvailable ? [] : ["EARN_AURORA_ROUTE_UNAVAILABLE"]),
            ],
            executionAvailable: false,
            quotedAtMs: Date.now(),
            expiresAtMs: Date.now() + 45000,
          }),
        } as Response;
      return {
        ok: true,
        json: async () => ({
          version: "gizu-monad-funding-v1",
          chainId: 143,
          owner: address,
          ...r,
          token: sourceUsdc,
          authorizationRequired: true,
          authorizationNonce: "0",
          referenceBlock: "100",
          referenceHash: "0x" + "a".repeat(64),
          feeCap: "100",
          remainingBudget: (BigInt(r.budget) - BigInt(r.amount) - 100n).toString(),
          entryPoint: earnEntryPoint,
          paymaster: earnPaymaster,
          delegation: earnDelegation,
          paymasterDataStatus: "stub",
          executionAvailable: false,
          timestampMs: Date.now(),
          expiresAtMs: Date.now() + 45000,
          operation: {
            sender: address,
            nonce: "0x0",
            callData: "0x1234",
            callGasLimit: "0x1",
            verificationGasLimit: "0x1",
            preVerificationGas: "0x1",
            paymasterVerificationGasLimit: "0x1",
            paymasterPostOpGasLimit: "0x1",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x0",
            paymaster: earnPaymaster,
            paymasterData: "0x1234",
          },
        }),
      } as Response;
    });
    setup(
      [],
      createEarnSourceFundingService(
        "https://backend.example",
        () =>
          native as unknown as NonNullable<
            ReturnType<typeof nativeBridge.getStoredEarnSponsoredSigner>
          >,
      ),
    );
    await open();
    await userEvent.type(await screen.findByLabelText("USDC funding budget"), "3");
    await userEvent.press(screen.getByRole("button", { name: "Review USDC funding" }));
    expect(await screen.findByText("Unsigned preview — no funds moved")).toBeVisible();
    if (quoteAvailable)
      expect(screen.getByText("Quoted minimum confidential credit: 2.988704 USDC")).toBeVisible();
    else {
      expect(
        screen.getByText(
          "Aurora cannot quote this route right now. No fresh credit or route fee estimate is available.",
        ),
      ).toBeVisible();
      expect(screen.queryByText(/Quoted minimum confidential credit:/)).toBeNull();
    }
    expect(screen.getByText(/Operation-specific settlement access is not qualified/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Authorize USDC funding" })).toBeDisabled();
    expect(screen.getAllByText("Fund confidential earn")).toHaveLength(1);
    expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  },
);

test("multi-account review authorizes each leg separately and gates payouts until the full batch is credited", async () => {
  const plans = [0, 4].map((sourceAccountIndex) => {
    const sourceAddress = "0x" + (sourceAccountIndex === 0 ? "1" : "7").repeat(40);
    return {
      sourceAccountIndex,
      sourceAddress,
      fundingBatchId: "batch_1",
      fundingBatchSize: 2,
      budget: "500000",
      expiresAtMs: Date.now() + 60000,
      quote: {
        operationId: `source_${sourceAccountIndex}`,
        revision: 1,
        quoteId: `q_${sourceAccountIndex}`,
        providerFeeBps: 2,
        recipient: "0x" + "5".repeat(40),
        chainId: 143 as const,
        token: sourceUsdc,
        amountAtoms: "489900",
        confidentialAccount: intent.confidentialAddress,
        refundOwner: sourceAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        minimumCreditAtoms: "480000",
      },
      fees: {
        amount: "489900",
        budget: "500000",
        feeCap: "100",
        remainingBudget: "10000",
        expiresAtMs: Date.now() + 60000,
        userOperation: { sender: sourceAddress, nonce: "0x0" },
      },
    };
  });
  const source = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    plan: jest.fn(),
    planMany: jest.fn().mockResolvedValue(plans),
    execute: jest.fn(),
    executeMany: jest.fn().mockImplementation(async (_intent, selected) =>
      selected.map((plan: (typeof plans)[number]) => ({
        operationId: plan.quote.operationId,
        walletId,
        revision: 2,
        kind: "sourceFunding",
        chainId: 143,
        sourceAccountIndex: plan.sourceAccountIndex,
        fundingBatchId: "batch_1",
        fundingBatchSize: 2,
        from: plan.sourceAddress,
        amountAtoms: "489900",
        nonce: "0x0",
        blocked: false,
        canResume: false,
        status: "credited",
        transactionHash: "0x" + "a".repeat(64),
        creditedAtoms: "480000",
      })),
    ),
    resume: jest.fn(),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const payout = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    execute: jest.fn(),
    resume: jest.fn(),
    reconcile: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  setup([], source, undefined, payout);
  await open();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("USDC funding budget"), "1");
  await user.press(screen.getByRole("button", { name: "Review USDC funding" }));
  expect(await screen.findByRole("button", { name: "Authorize USDC funding" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Authorize account 0 funding" })).toBeNull();
  expect(source.executeMany).not.toHaveBeenCalled();
  await user.press(screen.getByRole("button", { name: "Authorize USDC funding" }));
  expect(source.executeMany).toHaveBeenCalledTimes(1);
  expect(source.executeMany).toHaveBeenCalledWith(intent, plans);
  expect(source.execute).not.toHaveBeenCalled();
  expect(screen.getAllByText("Confirmed operation credit: 0.48 USDC")).toHaveLength(2);
  expect(
    await screen.findByRole("button", {
      name: "Review and authorize wallet 1 payout from account 0",
    }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Review and authorize wallet 1 payout from account 4" }),
  ).toBeEnabled();
  expect(payout.execute).not.toHaveBeenCalled();
});
