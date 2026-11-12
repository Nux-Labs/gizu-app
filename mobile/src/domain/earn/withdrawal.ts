import type { EarnIntent } from "./types";
import { earnAtoms, earnObject } from "./vaultExecution";
import { assertInvestmentSlot } from "./distribution";
export type EarnWithdrawalOperation = {
  investmentSlot?: number;
  operationId: string;
  walletId: string;
  cycleIndex?: number;
  returnOperationId?: string;
  revision: number;
  kind: "confidentialWithdrawal";
  leg: "withdrawal";
  chainId: 143;
  recipient: string;
  amountAtoms: string;
  minimumDestinationAtoms: string;
  receivedAtoms: string;
  status:
    "planned" | "signed" | "unknown" | "pending" | "paid" | "cancelled" | "expired" | "conflict";
  blocked: boolean;
  canResume: boolean;
  canRefreshUnsigned?: boolean;
  destinationTransactionHash?: string;
};
export interface EarnWithdrawalService {
  available(): Promise<boolean>;
  list(intent: EarnIntent): Promise<EarnWithdrawalOperation[]>;
  execute(
    intent: EarnIntent,
    returnOperationId: string,
    revision: number,
  ): Promise<EarnWithdrawalOperation>;
  resume(intent: EarnIntent, operation: EarnWithdrawalOperation): Promise<EarnWithdrawalOperation>;
  cancelUnsigned(
    intent: EarnIntent,
    operation: EarnWithdrawalOperation,
  ): Promise<EarnWithdrawalOperation>;
  reconcile(
    intent: EarnIntent,
    operation: EarnWithdrawalOperation,
  ): Promise<EarnWithdrawalOperation>;
  cancel(): void;
}
export function parseEarnWithdrawals(
  value: unknown,
  intent: EarnIntent,
): EarnWithdrawalOperation[] {
  if (!Array.isArray(value) || value.length > 256 || intent.status !== "prepared")
    throw new Error("Invalid native withdrawal journal.");
  const seen = new Set<string>();
  return value
    .filter((value) => (earnObject(value).cycleIndex ?? 0) === (intent.cycleIndex ?? 0))
    .map((value) => {
      const row = earnObject(value);
      assertInvestmentSlot(row, intent);
      if (
        typeof row.operationId !== "string" ||
        !/^[-a-zA-Z0-9_]{1,128}$/.test(row.operationId) ||
        seen.has(row.operationId) ||
        row.walletId !== intent.walletId ||
        !Number.isSafeInteger(row.revision) ||
        (row.revision as number) < 1 ||
        row.kind !== "confidentialWithdrawal" ||
        row.minimumReturnReceipt !== undefined ||
        row.verifiedMinimumAtoms !== undefined ||
        row.minimumReturnEnvelope !== undefined ||
        row.leg !== "withdrawal" ||
        row.chainId !== 143 ||
        typeof row.recipient !== "string" ||
        !/^0x[0-9a-f]{40}$/i.test(row.recipient) ||
        /^0x0{40}$/i.test(row.recipient) ||
        typeof row.blocked !== "boolean" ||
        typeof row.canResume !== "boolean" ||
        ![
          "planned",
          "signed",
          "unknown",
          "pending",
          "paid",
          "cancelled",
          "expired",
          "conflict",
        ].includes(String(row.status))
      )
        throw new Error("Native withdrawal binding changed.");
      if (
        [
          intent.sourceAddress,
          intent.confidentialAddress,
          ...intent.destinations.map((d) => d.address),
        ].some((address) => address.toLowerCase() === (row.recipient as string).toLowerCase())
      )
        throw new Error("Withdrawal requires its native receiving account.");
      seen.add(row.operationId);
      const amountAtoms = earnAtoms(row.amountAtoms),
        minimumDestinationAtoms = earnAtoms(row.minimumDestinationAtoms),
        receivedAtoms = earnAtoms(row.receivedAtoms);
      if (
        BigInt(amountAtoms) === 0n ||
        BigInt(minimumDestinationAtoms) === 0n ||
        BigInt(minimumDestinationAtoms) > BigInt(amountAtoms) ||
        (row.status === "paid" && BigInt(receivedAtoms) < BigInt(minimumDestinationAtoms))
      )
        throw new Error("Invalid withdrawal amount.");
      if (
        row.destinationTransactionHash !== undefined &&
        (typeof row.destinationTransactionHash !== "string" ||
          !/^0x[0-9a-f]{64}$/i.test(row.destinationTransactionHash) ||
          /^0x0{64}$/i.test(row.destinationTransactionHash))
      )
        throw new Error("Invalid withdrawal receipt.");
      if (row.status === "paid" && (!row.destinationTransactionHash || row.blocked))
        throw new Error("Withdrawal completion lacks verified receiving credit.");
      if (row.canRefreshUnsigned !== undefined && typeof row.canRefreshUnsigned !== "boolean")
        throw new Error("Invalid withdrawal refresh state.");
      return {
        operationId: row.operationId,
        walletId: intent.walletId,
        ...(row.investmentSlot !== undefined
          ? { investmentSlot: row.investmentSlot as number }
          : {}),
        ...(row.cycleIndex !== undefined ? { cycleIndex: row.cycleIndex as number } : {}),
        ...(typeof row.returnOperationId === "string"
          ? { returnOperationId: row.returnOperationId }
          : {}),
        revision: row.revision as number,
        kind: "confidentialWithdrawal",
        leg: "withdrawal",
        chainId: 143,
        recipient: row.recipient,
        amountAtoms,
        minimumDestinationAtoms,
        receivedAtoms,
        status: row.status as EarnWithdrawalOperation["status"],
        blocked: row.blocked,
        canResume: row.canResume,
        ...(row.canRefreshUnsigned !== undefined
          ? { canRefreshUnsigned: row.canRefreshUnsigned as boolean }
          : {}),
        ...(row.destinationTransactionHash
          ? { destinationTransactionHash: row.destinationTransactionHash as string }
          : {}),
      };
    });
}
