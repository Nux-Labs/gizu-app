import { createEarnDepositService } from "@/services/earn/depositJourney";
import { depositSnapshot } from "../../support/depositJourney";
const owner = { walletId: depositSnapshot().walletId };
function fixture() {
  const native = {
    prepareEarnDeposit: jest.fn().mockResolvedValue(depositSnapshot()),
    confirmEarnDeposit: jest.fn().mockResolvedValue({ ...depositSnapshot(), phase: "funding" }),
    getEarnDepositStatus: jest.fn().mockResolvedValue(depositSnapshot()),
    resumeEarnDeposit: jest.fn().mockResolvedValue({ ...depositSnapshot(), phase: "funding" }),
    cancelEarnDeposit: jest
      .fn()
      .mockResolvedValue({ ...depositSnapshot(), phase: "paused", pauseReason: "cancelled" }),
  };
  return { native, service: createEarnDepositService(() => native) };
}
test("validates ownership and amounts at the bridge boundary", async () => {
  const { native, service } = fixture();
  native.prepareEarnDeposit.mockResolvedValue({ ...depositSnapshot(), walletId: "other" });
  await expect(service.prepare(owner, "robinhood-usdg", "3000000")).rejects.toThrow(
    /Invalid native/,
  );
  native.getEarnDepositStatus.mockResolvedValue({
    ...depositSnapshot(),
    budgetAtoms: "unavailable",
  });
  await expect(service.status(owner, "deposit_1")).rejects.toThrow();
});
test("does not offer a missing native implementation", async () => {
  const service = createEarnDepositService(() => null);
  expect(await service.available()).toBe(false);
  await expect(service.prepare(owner, "robinhood-usdg", "3000000")).rejects.toThrow(/native/i);
});
test("reads saved native progress after an uncertain prepare before preparing again", async () => {
  const { native, service } = fixture();
  native.prepareEarnDeposit.mockRejectedValueOnce(new Error("bridge interrupted"));
  await expect(service.prepare(owner, "robinhood-usdg", "3000000")).rejects.toThrow(/interrupted/);
  expect(native.getEarnDepositStatus).toHaveBeenCalledWith(owner.walletId, "current-deposit");
  await service.prepare(owner, "robinhood-usdg", "3000000");
  expect(native.prepareEarnDeposit).toHaveBeenLastCalledWith(
    owner.walletId,
    "robinhood-usdg",
    "3000000",
    "deposit_1",
  );
});
test("does not prepare another pair if uncertain progress already has funding", async () => {
  const { native, service } = fixture();
  native.prepareEarnDeposit.mockRejectedValueOnce(new Error("bridge interrupted"));
  native.getEarnDepositStatus.mockResolvedValue({ ...depositSnapshot(), phase: "funding" });
  await expect(service.prepare(owner, "robinhood-usdg", "3000000")).rejects.toThrow();
  expect((await service.prepare(owner, "robinhood-usdg", "3000000")).phase).toBe("funding");
  expect(native.prepareEarnDeposit).toHaveBeenCalledTimes(1);
});
test("rejects duplicate authorization and cancel only revokes the named journey", async () => {
  const { native, service } = fixture();
  let resolve!: (v: unknown) => void;
  native.confirmEarnDeposit.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const first = service.confirm(owner, "deposit_1", 1);
  await expect(service.confirm(owner, "deposit_1", 1)).rejects.toThrow(/running/);
  const cancelled = await service.cancel(owner, "deposit_1", 1);
  expect(cancelled.phase).toBe("paused");
  expect(native.cancelEarnDeposit).toHaveBeenCalledWith(owner.walletId, "deposit_1", 1);
  resolve({ ...depositSnapshot(), phase: "funding" });
  await first;
  expect(native.confirmEarnDeposit).toHaveBeenCalledTimes(1);
});
test("intent lookup is scoped to the exact saved cycle", async () => {
  const { service, native } = fixture();
  const id = depositSnapshot().intentId;
  expect((await service.status(owner, "intent:" + id)).intentId).toBe(id);
  native.getEarnDepositStatus.mockResolvedValue({
    ...depositSnapshot(),
    intentId: "another_cycle",
  });
  await expect(service.status(owner, "intent:" + id)).rejects.toThrow(/identity/);
});

test("funding balance falls back to public only when the native capability is absent", async () => {
  const { service } = fixture();
  expect(await service.fundingBalance!(owner)).toBeNull();
});
test("funding balance validates native integer totals and preserves incomplete state", async () => {
  const { native } = fixture();
  const snapshot = {
    publicAtoms: "2000000",
    privateAtoms: "5000000",
    totalAtoms: "7000000",
    complete: true,
    checkedAtMs: Date.now(),
  };
  const readEarnDepositFundingBalance = jest.fn().mockResolvedValue(snapshot);
  const service = createEarnDepositService(() => ({ ...native, readEarnDepositFundingBalance }));
  expect(await service.fundingBalance!(owner)).toEqual(snapshot);
  expect(readEarnDepositFundingBalance).toHaveBeenCalledWith({ walletId: owner.walletId });
  readEarnDepositFundingBalance.mockResolvedValue({ ...snapshot, complete: false });
  expect((await service.fundingBalance!(owner))?.complete).toBe(false);
  for (const change of [
    { totalAtoms: "6999999" },
    { privateAtoms: "-1" },
    { checkedAtMs: 0 },
    { complete: "yes" },
  ]) {
    readEarnDepositFundingBalance.mockResolvedValue({ ...snapshot, ...change });
    await expect(service.fundingBalance!(owner)).rejects.toThrow();
  }
});
