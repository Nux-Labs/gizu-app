import type { EarnOwner, EarnProfileId } from "./types";

/** Saved execution activity only; reading this list never selects a cycle or signs. */
export type EarnInvestmentPosition = {
  intentId: string;
  cycleIndex: number;
  profileId: EarnProfileId;
  investmentSlot?: number;
  activity: "invested" | "redeemed" | "returned" | "pending";
  recoveryRequired: boolean;
  lastReturnOperationId?: string;
  /** Completed withdrawal lifecycle; the investment may still hold a remainder. */
  withdrawalComplete?: boolean;
  withdrawalAttention?: "confirming" | "unfinished" | "returning" | "checking";
};
export interface EarnInvestmentPositionsService {
  list(owner: EarnOwner): Promise<EarnInvestmentPosition[]>;
}

export function investmentPositionKey(
  row: Pick<EarnInvestmentPosition, "intentId" | "investmentSlot">,
) {
  return `${row.intentId}:${row.investmentSlot ?? "legacy"}`;
}

/** Native attention stands only while the vault's private-USDC decision has not finished it. */
export function openWithdrawalAttention(
  rows: readonly EarnInvestmentPosition[],
  covered: Readonly<Record<string, true>>,
): EarnInvestmentPosition["withdrawalAttention"] | null {
  const open = rows.filter(
    (row) => row.withdrawalAttention && !covered[investmentPositionKey(row)],
  );
  return (
    open.find((row) => row.withdrawalAttention !== "checking")?.withdrawalAttention ??
    open[0]?.withdrawalAttention ??
    null
  );
}

/** A known-zero vault stays closed until a saved portion still needs its private return. */
export function vaultWithdrawalAvailable(input: {
  amountAtoms: string | null;
  positions: readonly EarnInvestmentPosition[];
  covered: Readonly<Record<string, true>>;
  profileId: EarnProfileId;
  checked: boolean;
}): boolean {
  if (input.amountAtoms === null) return true;
  let amount: bigint;
  try {
    amount = BigInt(input.amountAtoms);
  } catch {
    return true;
  }
  if (amount > 0n) return true;
  if (!input.checked) return false;
  return input.positions.some(
    (row) =>
      row.profileId === input.profileId &&
      row.withdrawalAttention !== undefined &&
      row.withdrawalAttention !== "checking" &&
      !input.covered[investmentPositionKey(row)],
  );
}

/** Screen-local proof; never persisted as native completion or spending authority. */
export type EarnInvestmentExitProof = {
  walletId: string;
  intentId: string;
  profileId: EarnProfileId;
  investmentSlot?: number;
  expiresAtMs: number | null;
  /** The native return is confirmed; full exit checks must still verify public residuals and saved payouts. */
  settled?: boolean;
};
