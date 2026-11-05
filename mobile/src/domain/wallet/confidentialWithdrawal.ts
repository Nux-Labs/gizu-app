export const confidentialWithdrawalStatuses = [
  "review",
  "pending",
  "unknown",
  "paid",
  "cancelled",
  "needsReview",
  "conflict",
] as const;
export type ConfidentialWithdrawalStatus = (typeof confidentialWithdrawalStatuses)[number];
export type ConfidentialWithdrawalPayout = {
  slot: number;
  amountAtoms: string;
  minimumDestinationAtoms: string;
  receivedAtoms: string;
  status: ConfidentialWithdrawalStatus;
};
export type ConfidentialWithdrawal = {
  walletId: string;
  operationId: string;
  revision: number;
  amountAtoms: string;
  minimumDestinationAtoms: string;
  receivedAtoms: string;
  walletCount: number;
  weightsBps: number[];
  status: ConfidentialWithdrawalStatus;
  canResume: boolean;
  canCancel: boolean;
  payouts: ConfidentialWithdrawalPayout[];
};
export interface ConfidentialWithdrawalService {
  available(): Promise<boolean>;
  read(): Promise<ConfidentialWithdrawal | null>;
  prepare(amountAtoms: string): Promise<ConfidentialWithdrawal>;
  execute(plan: ConfidentialWithdrawal): Promise<ConfidentialWithdrawal>;
  resume(plan: ConfidentialWithdrawal): Promise<ConfidentialWithdrawal>;
  cancel(plan: ConfidentialWithdrawal): Promise<ConfidentialWithdrawal>;
}
const maxAmount = 18446744073709551615n;
export function privateWithdrawalAtoms(input: string): string {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(input.trim()))
    throw new Error("Enter a USDC amount with at most six decimal places.");
  const [whole, fraction = ""] = input.trim().split(".");
  const value = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (value === 0n || value > maxAmount) throw new Error("Enter a supported positive USDC amount.");
  return value.toString();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native withdrawal.");
  return value as Record<string, unknown>;
}
function atoms(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > maxAmount
  )
    throw new Error("Invalid native withdrawal amount.");
  return value;
}
function status(value: unknown): ConfidentialWithdrawalStatus {
  if (!confidentialWithdrawalStatuses.includes(value as ConfidentialWithdrawalStatus))
    throw new Error("Invalid native withdrawal status.");
  return value as ConfidentialWithdrawalStatus;
}
export function parseConfidentialWithdrawal(
  value: unknown,
  walletId: string,
): ConfidentialWithdrawal | null {
  if (value === null) return null;
  const row = object(value);
  if (
    row.walletId !== walletId ||
    typeof row.operationId !== "string" ||
    !/^[-a-zA-Z0-9_]{1,128}$/.test(row.operationId) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    !Number.isInteger(row.walletCount) ||
    (row.walletCount as number) < 1 ||
    (row.walletCount as number) > 5 ||
    typeof row.canCancel !== "boolean" ||
    typeof row.canResume !== "boolean" ||
    !Array.isArray(row.weightsBps) ||
    row.weightsBps.length !== row.walletCount ||
    row.weightsBps.some((w) => !Number.isInteger(w) || w <= 0 || w > 10000) ||
    row.weightsBps.reduce((a, b) => a + b, 0) !== 10000 ||
    !Array.isArray(row.payouts) ||
    row.payouts.length !== row.walletCount
  )
    throw new Error("Native withdrawal identity or distribution changed.");
  const unsignedDraft =
    (row.status === "needsReview" || row.status === "cancelled") && row.canCancel === true;
  const cancelledDraft =
    row.status === "cancelled" && row.canCancel === false && row.canResume === false;
  const partialRecovery =
    ["needsReview", "unknown", "pending"].includes(String(row.status)) &&
    row.canResume === true &&
    row.canCancel === false &&
    row.payouts.some((p) => ["paid", "pending", "unknown"].includes(String(object(p).status)));
  const payouts = row.payouts.map((value, slot): ConfidentialWithdrawalPayout => {
    const p = object(value);
    if (p.slot !== slot) throw new Error("Native withdrawal receiver changed.");
    const result = {
      slot,
      amountAtoms: atoms(p.amountAtoms),
      minimumDestinationAtoms: atoms(p.minimumDestinationAtoms),
      receivedAtoms: atoms(p.receivedAtoms),
      status: status(p.status),
    };
    if (
      BigInt(result.amountAtoms) === 0n ||
      (BigInt(result.minimumDestinationAtoms) === 0n &&
        (!(unsignedDraft || cancelledDraft || partialRecovery) ||
          !["needsReview", "cancelled"].includes(result.status) ||
          result.receivedAtoms !== "0")) ||
      BigInt(result.minimumDestinationAtoms) > BigInt(result.amountAtoms) ||
      (result.status === "paid" &&
        BigInt(result.receivedAtoms) < BigInt(result.minimumDestinationAtoms))
    )
      throw new Error("Native withdrawal credit is inconsistent.");
    return result;
  });
  const sum = (field: "amountAtoms" | "minimumDestinationAtoms" | "receivedAtoms") =>
    payouts.reduce((total, p) => total + BigInt(p[field]), 0n).toString();
  const result: ConfidentialWithdrawal = {
    walletId,
    operationId: row.operationId,
    revision: row.revision as number,
    walletCount: row.walletCount as number,
    weightsBps: [...row.weightsBps] as number[],
    amountAtoms: atoms(row.amountAtoms),
    minimumDestinationAtoms: atoms(row.minimumDestinationAtoms),
    receivedAtoms: atoms(row.receivedAtoms),
    status: status(row.status),
    canResume: row.canResume,
    canCancel: row.canCancel,
    payouts,
  };
  let remaining = BigInt(result.amountAtoms);
  for (const payout of payouts) {
    const expected =
      payout.slot + 1 === payouts.length
        ? remaining
        : (BigInt(result.amountAtoms) * BigInt(result.weightsBps[payout.slot]!)) / 10000n;
    if (BigInt(payout.amountAtoms) !== expected)
      throw new Error("Native withdrawal allocation changed.");
    remaining -= expected;
  }
  if (
    result.amountAtoms !== sum("amountAtoms") ||
    result.minimumDestinationAtoms !== sum("minimumDestinationAtoms") ||
    result.receivedAtoms !== sum("receivedAtoms") ||
    ((unsignedDraft || cancelledDraft) &&
      payouts.some((p) => !["review", "needsReview", "cancelled"].includes(p.status))) ||
    (result.status === "paid" &&
      (payouts.some((p) => p.status !== "paid") || result.canCancel || result.canResume)) ||
    (result.canCancel &&
      payouts.some((p) => !["review", "needsReview", "cancelled"].includes(p.status)))
  )
    throw new Error("Native withdrawal totals or recovery flags changed.");
  return result;
}
