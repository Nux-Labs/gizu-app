import { allocateWithdrawal, parseWithdrawalSelection } from "@/domain/earn/withdrawalSelection";
const positions = [
  { intentId: "cycle_a", cycleIndex: 0, investmentSlot: 0, assetsAtoms: "600000" },
  { intentId: "cycle_a", cycleIndex: 0, investmentSlot: 1, assetsAtoms: "800000" },
];
test("a vault amount consumes only selected portions and leaves the remainder invested", () => {
  expect(allocateWithdrawal("1000000", positions)).toEqual([
    { ...positions[0], amountAtoms: "600000", allShares: true },
    { ...positions[1], amountAtoms: "400000", allShares: false },
  ]);
  expect(allocateWithdrawal("400000", positions)).toEqual([
    { ...positions[0], amountAtoms: "400000", allShares: false },
  ]);
  expect(() => allocateWithdrawal("1400001", positions)).toThrow(/exceeds/i);
  expect(() => allocateWithdrawal("0", positions)).toThrow();
});
test("reopening restores an exact wallet-scoped request but rejects altered totals or duplicate portions", () => {
  const request = {
    version: 1,
    walletId: "wallet",
    profileId: "robinhood-usdg",
    requestId: "request_1",
    amountAtoms: "1000000",
    portions: allocateWithdrawal("1000000", positions),
  };
  expect(parseWithdrawalSelection(request, "wallet")).toEqual(request);
  expect(() => parseWithdrawalSelection(request, "other")).toThrow();
  expect(() => parseWithdrawalSelection({ ...request, amountAtoms: "999999" }, "wallet")).toThrow();
  expect(() =>
    parseWithdrawalSelection(
      { ...request, portions: [request.portions[0], request.portions[0]] },
      "wallet",
    ),
  ).toThrow();
});
