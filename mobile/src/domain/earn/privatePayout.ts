import { earnAtoms, earnObject } from "./vaultExecution";
import type { SponsoredOperation } from "./sourceFunding";
import { earnProfiles, type EarnIntent } from "./types";
import { payoutDestination, payoutLegs, type DistributionPayoutLeg } from "./distribution";
export type PayoutLeg = "hold" | "invest" | DistributionPayoutLeg;
export type PayoutRequest = {
  cycleIndex?: number;
  walletId: string;
  sourceOperationId: string;
  sourceRevision: number;
  leg: PayoutLeg;
};
export type PayoutOperation = {
  sourceOperationId?: string;
  cycleIndex?: number;
  operationId: string;
  walletId: string;
  revision: number;
  kind: "confidentialPayout";
  leg: PayoutLeg;
  chainId: 1 | 4663;
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
export interface EarnPayoutService {
  available(): Promise<boolean>;
  list(intent: EarnIntent): Promise<PayoutOperation[]>;
  execute(intent: EarnIntent, source: SponsoredOperation, leg: PayoutLeg): Promise<PayoutOperation>;
  resume(intent: EarnIntent, op: PayoutOperation): Promise<PayoutOperation>;
  reconcile(intent: EarnIntent, op: PayoutOperation): Promise<PayoutOperation>;
  cancelUnsigned(intent: EarnIntent, op: PayoutOperation): Promise<PayoutOperation>;
  cancel(): void;
}
export function payoutRequest(
  intent: EarnIntent,
  source: SponsoredOperation,
  leg: PayoutLeg,
): PayoutRequest {
  payoutDestination(intent, leg);
  if (
    intent.status !== "prepared" ||
    source.walletId !== intent.walletId ||
    source.kind !== "sourceFunding" ||
    source.chainId !== 143 ||
    (source.sourceAccountIndex === undefined &&
      source.from.toLowerCase() !== intent.sourceAddress.toLowerCase()) ||
    source.status !== "credited" ||
    source.minimumReturnReceipt !== undefined ||
    source.verifiedMinimumAtoms !== undefined ||
    source.blocked ||
    !source.transactionHash ||
    !source.creditedAtoms ||
    BigInt(earnAtoms(source.creditedAtoms)) < 10n ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    !/^[-a-zA-Z0-9_]{1,128}$/.test(source.operationId)
  )
    throw new Error("An authenticated credit for the confirmed funding operation is required.");
  return {
    walletId: intent.walletId,
    ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
    sourceOperationId: source.operationId,
    sourceRevision: source.revision,
    leg,
  };
}
export function parsePayoutOperations(value: unknown, intent: EarnIntent): PayoutOperation[] {
  if (intent.status !== "prepared" || !Array.isArray(value) || value.length > 512)
    throw new Error("Invalid native payout journal.");
  const seen = new Set<string>();
  return value.map((v) => {
    const q = earnObject(v),
      operationId = q.operationId,
      leg = q.leg;
    if (
      typeof operationId !== "string" ||
      !/^[-a-zA-Z0-9_]{1,128}$/.test(operationId) ||
      seen.has(operationId) ||
      q.walletId !== intent.walletId ||
      q.kind !== "confidentialPayout" ||
      q.minimumReturnReceipt !== undefined ||
      q.verifiedMinimumAtoms !== undefined ||
      q.minimumReturnEnvelope !== undefined ||
      !payoutLegs(intent).includes(leg as PayoutLeg) ||
      q.chainId !== earnProfiles[intent.profileId].chainId ||
      typeof q.recipient !== "string" ||
      q.recipient.toLowerCase() !== payoutDestination(intent, String(leg)).address.toLowerCase() ||
      typeof q.revision !== "number" ||
      !Number.isSafeInteger(q.revision) ||
      q.revision < 1 ||
      typeof q.blocked !== "boolean" ||
      typeof q.canResume !== "boolean" ||
      ![
        "planned",
        "signed",
        "unknown",
        "pending",
        "paid",
        "cancelled",
        "expired",
        "conflict",
      ].includes(String(q.status))
    )
      throw new Error("Native payout binding changed.");
    seen.add(operationId);
    const amount = earnAtoms(q.amountAtoms),
      minimum = earnAtoms(q.minimumDestinationAtoms),
      received = earnAtoms(q.receivedAtoms);
    if (BigInt(amount) === 0n || BigInt(minimum) === 0n)
      throw new Error("Invalid payout quantity.");
    let tx: string | undefined;
    if (q.destinationTransactionHash !== undefined) {
      if (
        typeof q.destinationTransactionHash !== "string" ||
        !/^0x[0-9a-f]{64}$/i.test(q.destinationTransactionHash) ||
        /^0x0{64}$/i.test(q.destinationTransactionHash)
      )
        throw new Error("Invalid payout receipt.");
      tx = q.destinationTransactionHash;
    }
    if (q.status === "paid" && (!tx || BigInt(received) < BigInt(minimum) || q.blocked))
      throw new Error("Payout completion lacks verified destination credit.");
    return {
      operationId,
      ...(typeof q.sourceOperationId === "string"
        ? { sourceOperationId: q.sourceOperationId }
        : {}),
      ...(q.cycleIndex !== undefined ? { cycleIndex: q.cycleIndex as number } : {}),
      walletId: intent.walletId,
      revision: q.revision,
      kind: "confidentialPayout",
      leg: leg as PayoutLeg,
      chainId: q.chainId as 1 | 4663,
      recipient: q.recipient,
      amountAtoms: amount,
      minimumDestinationAtoms: minimum,
      receivedAtoms: received,
      status: q.status as PayoutOperation["status"],
      blocked: q.blocked,
      canResume: q.canResume,
      ...(typeof q.canRefreshUnsigned === "boolean"
        ? { canRefreshUnsigned: q.canRefreshUnsigned }
        : {}),
      ...(tx ? { destinationTransactionHash: tx } : {}),
    };
  });
}
