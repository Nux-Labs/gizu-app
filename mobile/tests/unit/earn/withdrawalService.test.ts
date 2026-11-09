import { createEarnWithdrawalService } from "@/services/earn/withdrawal";
import { parseEarnWithdrawals } from "@/domain/earn/withdrawal";
import { hoodIntent } from "../../support/robinhoodEarn";
import { deferred } from "../../support/renderApp";
const recipient = "0x" + "8".repeat(40);
const operation = {
  walletId: hoodIntent.walletId,
  operationId: "withdrawal_1",
  returnOperationId: "return_1",
  revision: 1,
  kind: "confidentialWithdrawal",
  leg: "withdrawal",
  chainId: 143,
  recipient,
  amountAtoms: "899000",
  minimumDestinationAtoms: "880000",
  receivedAtoms: "0",
  status: "pending",
  blocked: true,
  canResume: false,
};
function setup() {
  const native = {
    executeEarnWithdrawal: jest.fn().mockResolvedValue(operation),
    listEarnWithdrawalOperations: jest.fn().mockResolvedValue([operation]),
    resumeEarnWithdrawalOperation: jest.fn().mockResolvedValue(operation),
    cancelEarnWithdrawalOperation: jest.fn(),
    readEarnWithdrawalSettlement: jest.fn().mockResolvedValue({
      ...operation,
      status: "paid",
      blocked: false,
      receivedAtoms: "890000",
      destinationTransactionHash: "0x" + "a".repeat(64),
    }),
    lock: jest.fn(),
  };
  return { native, service: createEarnWithdrawalService(() => native) };
}
test("withdrawal authorizes the exact return revision and separates submission from receiving settlement", async () => {
  const { native, service } = setup();
  const submitted = await service.execute(hoodIntent, "return_1", 4);
  expect(native.executeEarnWithdrawal).toHaveBeenCalledWith(hoodIntent.walletId, "return_1", 4);
  expect(submitted.status).toBe("pending");
  expect((await service.reconcile(hoodIntent, submitted)).status).toBe("paid");
  await expect(service.cancelUnsigned(hoodIntent, submitted)).rejects.toThrow(/reconciled/);
});
test("cancellation ignores a late native withdrawal result and rejects duplicate submissions", async () => {
  const { native, service } = setup();
  const pending = deferred<typeof operation>();
  native.executeEarnWithdrawal.mockReturnValue(pending.promise);
  const first = service.execute(hoodIntent, "return_1", 4);
  await expect(service.execute(hoodIntent, "return_1", 4)).rejects.toThrow(/running/);
  service.cancel();
  pending.resolve(operation);
  await expect(first).rejects.toThrow(/closed/);
  expect(native.lock).toHaveBeenCalledTimes(1);
});
test("native withdrawal results reject source/C recipients, wrong networks, and insufficient paid credits", () => {
  for (const change of [
    { recipient: hoodIntent.sourceAddress },
    { recipient: hoodIntent.confidentialAddress },
    { chainId: 4663 },
    { walletId: "other" },
    { status: "paid", receivedAtoms: "1" },
    { verifiedMinimumAtoms: "880000" },
    { minimumReturnReceipt: {} },
    { minimumReturnEnvelope: "private" },
  ])
    expect(() => parseEarnWithdrawals([{ ...operation, ...change }], hoodIntent)).toThrow();
});
