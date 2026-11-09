import {
  parseConfidentialWithdrawal,
  privateWithdrawalAtoms,
} from "@/domain/wallet/confidentialWithdrawal";
import { createConfidentialWithdrawalService } from "@/services/wallet/confidentialWithdrawal";

const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const view = () => ({
  walletId,
  operationId: "cashout_1",
  revision: 1,
  amountAtoms: "10000000",
  minimumDestinationAtoms: "9800000",
  receivedAtoms: "0",
  walletCount: 2,
  weightsBps: [6000, 4000],
  status: "review",
  canResume: true,
  canCancel: true,
  payouts: [
    {
      slot: 0,
      amountAtoms: "6000000",
      minimumDestinationAtoms: "5900000",
      receivedAtoms: "0",
      status: "review",
    },
    {
      slot: 1,
      amountAtoms: "4000000",
      minimumDestinationAtoms: "3900000",
      receivedAtoms: "0",
      status: "review",
    },
  ],
});
test("withdrawal amounts are exact six-decimal private debit budgets", () => {
  expect(privateWithdrawalAtoms("10.000001")).toBe("10000001");
  for (const input of ["", "0", "-1", "1e3", "1.0000001", "18446744073709.551616"])
    expect(() => privateWithdrawalAtoms(input)).toThrow();
});
test("native public withdrawal view preserves exact allocations and rejects foreign or inconsistent progress", () => {
  expect(parseConfidentialWithdrawal(view(), walletId)?.walletCount).toBe(2);
  expect(parseConfidentialWithdrawal(null, walletId)).toBeNull();
  for (const change of [
    { walletId: "foreign" },
    { walletCount: 3 },
    { weightsBps: [6000, 5000] },
    { weightsBps: [5000, 5000] },
    { amountAtoms: "9999999" },
    { minimumDestinationAtoms: "9800001" },
    { receivedAtoms: "100" },
    { status: "paid" },
    { verifiedMinimumAtoms: "9800000" },
    { minimumReturnReceipt: {} },
    { minimumReturnEnvelope: "private" },
    { payouts: [view().payouts[0], view().payouts[0]] },
    { canCancel: true, payouts: [{ ...view().payouts[0], status: "unknown" }, view().payouts[1]] },
  ])
    expect(() => parseConfidentialWithdrawal({ ...view(), ...change }, walletId)).toThrow();
});
test("paid withdrawal requires every receiver's verified minimum and locks cancellation", () => {
  const paid = {
    ...view(),
    status: "paid",
    canResume: false,
    canCancel: false,
    receivedAtoms: "9800000",
    payouts: view().payouts.map((p) => ({
      ...p,
      status: "paid",
      receivedAtoms: p.minimumDestinationAtoms,
    })),
  };
  expect(parseConfidentialWithdrawal(paid, walletId)?.status).toBe("paid");
  expect(() =>
    parseConfidentialWithdrawal(
      { ...paid, payouts: [{ ...paid.payouts[0], receivedAtoms: "1" }, paid.payouts[1]] },
      walletId,
    ),
  ).toThrow();
});
test("an unsigned failed quote retains a resumable draft without inventing payout terms", () => {
  const draft = {
    ...view(),
    status: "needsReview",
    minimumDestinationAtoms: "0",
    payouts: view().payouts.map((p) => ({
      ...p,
      minimumDestinationAtoms: "0",
      status: "needsReview",
    })),
  };
  expect(parseConfidentialWithdrawal(draft, walletId)?.canCancel).toBe(true);
  expect(() => parseConfidentialWithdrawal({ ...draft, status: "review" }, walletId)).toThrow();
  expect(() => parseConfidentialWithdrawal({ ...draft, canCancel: false }, walletId)).toThrow();
});
test("a partial paid withdrawal remains recoverable when a later unsigned quote fails", () => {
  const partial = {
    ...view(),
    status: "needsReview",
    canCancel: false,
    minimumDestinationAtoms: "5900000",
    receivedAtoms: "5950000",
    payouts: [
      { ...view().payouts[0]!, status: "paid", receivedAtoms: "5950000" },
      { ...view().payouts[1]!, status: "needsReview", minimumDestinationAtoms: "0" },
    ],
  };
  expect(parseConfidentialWithdrawal(partial, walletId)?.canResume).toBe(true);
  expect(() => parseConfidentialWithdrawal({ ...partial, status: "review" }, walletId)).toThrow();
  expect(() => parseConfidentialWithdrawal({ ...partial, canCancel: true }, walletId)).toThrow();
});
test("adapter sends only the chosen amount and saved native identity, never wallet recipients", async () => {
  const bridge = {
    getConfidentialWithdrawal: jest.fn().mockResolvedValue(null),
    prepareConfidentialWithdrawal: jest.fn().mockResolvedValue(view()),
    executeConfidentialWithdrawal: jest
      .fn()
      .mockResolvedValue({ ...view(), status: "pending", canCancel: false }),
    resumeConfidentialWithdrawal: jest.fn().mockResolvedValue(view()),
    cancelConfidentialWithdrawal: jest
      .fn()
      .mockResolvedValue({ ...view(), status: "cancelled", canCancel: false, canResume: false }),
  };
  const service = createConfidentialWithdrawalService(walletId, () => bridge);
  const plan = await service.prepare("10000000");
  expect(bridge.prepareConfidentialWithdrawal).toHaveBeenCalledWith({
    walletId,
    amountAtoms: "10000000",
  });
  await service.execute(plan);
  expect(bridge.executeConfidentialWithdrawal).toHaveBeenCalledWith({
    walletId,
    operationId: "cashout_1",
    revision: 1,
  });
  expect(bridge.resumeConfidentialWithdrawal).not.toHaveBeenCalled();
});
test("unsupported native builds cannot pretend to prepare or complete a withdrawal", async () => {
  const service = createConfidentialWithdrawalService(walletId, () => null);
  expect(await service.available()).toBe(false);
  await expect(service.prepare("1")).rejects.toThrow(/updated native/);
});
