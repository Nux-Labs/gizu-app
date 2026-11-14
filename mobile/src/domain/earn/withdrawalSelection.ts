export type WithdrawalCapacity = {
  intentId: string;
  cycleIndex: number;
  investmentSlot?: number;
  assetsAtoms: string;
  afterReturnOperationId?: string;
};
export type WithdrawalPortion = WithdrawalCapacity & { amountAtoms: string; allShares: boolean };
export type WithdrawalSelection = {
  version: 1;
  walletId: string;
  profileId: "robinhood-usdg";
  requestId: string;
  amountAtoms: string;
  portions: WithdrawalPortion[];
};
export const withdrawalPortionKey = (
  row: Pick<WithdrawalCapacity, "intentId" | "investmentSlot">,
) => `${row.intentId}:${row.investmentSlot ?? "legacy"}`;
const atoms = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
export function allocateWithdrawal(
  amountAtoms: string,
  positions: WithdrawalCapacity[],
): WithdrawalPortion[] {
  if (!atoms(amountAtoms) || BigInt(amountAtoms) <= 0n)
    throw new Error("Enter a positive withdrawal amount.");
  let remaining = BigInt(amountAtoms);
  const portions: WithdrawalPortion[] = [];
  for (const position of positions) {
    if (!atoms(position.assetsAtoms)) throw new Error("Withdrawal balances changed.");
    const available = BigInt(position.assetsAtoms);
    if (available === 0n || remaining === 0n) continue;
    const amount = remaining < available ? remaining : available;
    portions.push({ ...position, amountAtoms: amount.toString(), allShares: amount === available });
    remaining -= amount;
  }
  if (remaining !== 0n)
    throw new Error("The amount exceeds your current withdrawable vault balance.");
  return portions;
}
export function parseWithdrawalSelection(value: unknown, walletId: string): WithdrawalSelection {
  const r = value as WithdrawalSelection;
  if (
    !r ||
    r.version !== 1 ||
    r.walletId !== walletId ||
    r.profileId !== "robinhood-usdg" ||
    !/^[-a-zA-Z0-9_]{1,128}$/.test(r.requestId) ||
    !atoms(r.amountAtoms) ||
    BigInt(r.amountAtoms) === 0n ||
    !Array.isArray(r.portions) ||
    r.portions.length < 1 ||
    r.portions.length > 256
  )
    throw new Error("Saved withdrawal request is invalid.");
  const seen = new Set<string>();
  let total = 0n;
  for (const row of r.portions) {
    if (
      !row ||
      typeof row.intentId !== "string" ||
      !row.intentId ||
      row.intentId.length > 1024 ||
      !Number.isSafeInteger(row.cycleIndex) ||
      row.cycleIndex < 0 ||
      (row.investmentSlot !== undefined &&
        (!Number.isInteger(row.investmentSlot) ||
          row.investmentSlot < 0 ||
          row.investmentSlot > 4)) ||
      !atoms(row.assetsAtoms) ||
      !atoms(row.amountAtoms) ||
      BigInt(row.amountAtoms) === 0n ||
      BigInt(row.amountAtoms) > BigInt(row.assetsAtoms) ||
      row.allShares !== (row.amountAtoms === row.assetsAtoms) ||
      seen.has(withdrawalPortionKey(row))
    )
      throw new Error("Saved withdrawal portion is invalid.");
    if (
      row.afterReturnOperationId !== undefined &&
      !/^[-a-zA-Z0-9_]{1,128}$/.test(row.afterReturnOperationId)
    )
      throw new Error("Invalid past return reference.");
    seen.add(withdrawalPortionKey(row));
    total += BigInt(row.amountAtoms);
  }
  if (total !== BigInt(r.amountAtoms)) throw new Error("Saved withdrawal total changed.");
  return r;
}
