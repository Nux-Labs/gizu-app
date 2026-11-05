import { render, screen, userEvent } from "@testing-library/react-native";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import { EarnProvider } from "@/features/earn/EarnProvider";
import { ExitCompletionPanel } from "@/features/earn/ExitCompletionPanel";
import { parseExitSnapshot } from "@/domain/earn/exitCompletion";
import type { EarnWithdrawalOperation } from "@/domain/earn/withdrawal";
import { hoodIntent } from "../../support/robinhoodEarn";
import { exitSnapshot } from "../../support/exitCompletion";
import { mainnetPortfolio } from "../../support/mainnetWallet";
function setup() {
  const submitted: EarnWithdrawalOperation = {
    walletId: hoodIntent.walletId,
    operationId: "withdrawal_1",
    returnOperationId: "return_1",
    revision: 2,
    kind: "confidentialWithdrawal",
    leg: "withdrawal",
    chainId: 143,
    recipient: "0x" + "8".repeat(40),
    amountAtoms: "899000",
    minimumDestinationAtoms: "880000",
    receivedAtoms: "0",
    status: "pending",
    blocked: true,
    canResume: false,
  };
  const withdrawal = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([submitted]),
    execute: jest.fn().mockResolvedValue(submitted),
    resume: jest.fn(),
    reconcile: jest.fn().mockResolvedValue({
      ...submitted,
      status: "paid",
      blocked: false,
      receivedAtoms: "890000",
      destinationTransactionHash: "0x" + "a".repeat(64),
    }),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const check = {
    check: jest.fn().mockResolvedValue({
      snapshot: parseExitSnapshot(exitSnapshot(Date.now()), hoodIntent, Date.now()),
      creditedReturnOperationIds: ["return_1"],
      creditedReturns: [{ operationId: "return_1", revision: 4 }],
      complete: true,
    }),
  };
  render(
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
        service={{
          load: jest.fn().mockResolvedValue(hoodIntent),
          prepare: jest.fn(),
          cancel: jest.fn(),
        }}
      >
        <ExitCompletionPanel intent={hoodIntent} service={check} withdrawal={withdrawal} />
      </EarnProvider>
    </MainnetWalletProvider>,
  );
  return { withdrawal };
}
test("a verified private return preserves settlement recovery for an already authorized public payout", async () => {
  const { withdrawal } = setup();
  expect(screen.queryByRole("button", { name: /Review withdrawal to Monad/ })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText("Previously saved public withdrawal · pending")).toBeVisible();
  expect(withdrawal.execute).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Review withdrawal to Monad/ })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Check Monad withdrawal settlement" }));
  expect(
    await screen.findByText("Received 0.89 USDC in the Monad receiving account."),
  ).toBeVisible();
  expect(withdrawal.execute).not.toHaveBeenCalled();
});
