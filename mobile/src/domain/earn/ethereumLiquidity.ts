import {
  investmentDestination,
  investmentSlotField,
  assertInvestmentSlot,
} from "@/domain/earn/distribution";
import { earnAtoms, earnObject, type VaultPlan } from "./vaultExecution";
import { earnProfiles, monadConfidentialUsdcAssetId, type EarnIntent } from "./types";
import { ceilDiv } from "./policy";
import { parseMinimumReturn, type MinimumReturnReceipt } from "./minimumReturn";
export type LiquidityKind = "fusionEthOrder" | "fusionUsdcApproval" | "returnUsdc" | "returnEth";
export type FusionProposal = {
  cycleIndex?: number;
  investmentSlot?: number;
  kind: "fusionEthOrder";
  operationId: string;
  revision: number;
  chainId: 1;
  expectedFrom: string;
  confidentialAccount: string;
  quoteId: string;
  inputAtoms: string;
  minimumEthWei: string;
  grossEthWei: string;
  maximumResolverOverheadWei: string;
  deadline: number;
  fundingMode: "permit";
  unsignedOrder: Record<string, string>;
  extension: string;
};
export type ReturnProposal = {
  cycleIndex?: number;
  investmentSlot?: number;
  kind: "returnUsdc" | "returnEth";
  operationId: string;
  revision: number;
  chainId: 1;
  expectedFrom: string;
  confidentialAccount: string;
  refundOwner: string;
  quoteId: string;
  recipient: string;
  amountAtoms: string;
  nonce: number;
  deadline: number;
  gasLimit: number;
  maxFeePerGasWei: string;
  priorityFeePerGasWei: string;
  maximumGasCostWei: string;
  withdrawalReserveWei: string;
};
export type LiquidityRequest = { walletId: string; proposal: FusionProposal | ReturnProposal };
export type LiquidityPlan = {
  proposal: FusionProposal | ReturnProposal;
  expiresAtMs: number;
  minimumCreditAtoms?: string;
  resolverOverheadWei?: string;
};
export type LiquidityOperation = {
  operationId: string;
  walletId: string;
  revision: number;
  kind: LiquidityKind;
  chainId: 1;
  from: string;
  amountAtoms: string;
  blocked: boolean;
  canResume: boolean;
  status:
    | "planned"
    | "permitSaved"
    | "signed"
    | "unknown"
    | "pending"
    | "fusionFilled"
    | "approvalFinalized"
    | "awaitingSettlement"
    | "credited"
    | "minimumReceived"
    | "cancelled"
    | "reverted"
    | "expired"
    | "cancellationPending"
    | "nonceCancelled";
  canCancelPending?: boolean;
  cancellationTransactionHash?: string;
  cancellationTransactionHashes?: string[];
  transactionHash?: string;
  orderHash?: string;
  actualFeeWei?: string;
  receivedEthWei?: string;
  creditedAtoms?: string;
  verifiedMinimumAtoms?: string;
  minimumReturnReceipt?: MinimumReturnReceipt;
};
export interface EarnLiquidityService {
  available(): Promise<boolean>;
  bootstrap(intent: EarnIntent, plan: VaultPlan): Promise<LiquidityPlan>;
  returnPlan(
    intent: EarnIntent,
    asset: "usdc" | "native",
    signal: AbortSignal,
  ): Promise<LiquidityPlan>;
  execute(intent: EarnIntent, plan: LiquidityPlan): Promise<LiquidityOperation>;
  list(intent: EarnIntent): Promise<LiquidityOperation[]>;
  resume(intent: EarnIntent, op: LiquidityOperation): Promise<LiquidityOperation>;
  reconcileCredit(intent: EarnIntent, op: LiquidityOperation): Promise<LiquidityOperation>;
  cancelUnsigned(intent: EarnIntent, op: LiquidityOperation): Promise<LiquidityOperation>;
  cancelPending(intent: EarnIntent, op: LiquidityOperation): Promise<LiquidityOperation>;
  cancel(): void;
}
function number(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Invalid liquidity integer.");
  return v;
}
function addr(v: unknown, expected?: string) {
  if (
    typeof v !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(v) ||
    /^0x0{40}$/i.test(v) ||
    (expected && v.toLowerCase() !== expected.toLowerCase())
  )
    throw new Error("Liquidity owner or recipient changed.");
  return v;
}
function hash(v: unknown) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/i.test(v) || /^0x0{64}$/i.test(v))
    throw new Error("Invalid liquidity reference.");
  return v;
}
function id(v: unknown) {
  if (typeof v !== "string" || !/^[-a-zA-Z0-9_]{1,128}$/.test(v))
    throw new Error("Invalid liquidity operation.");
  return v;
}
function identity(intent: EarnIntent) {
  if (
    intent.profileId !== "ethereum-usdc" ||
    intent.status !== "prepared" ||
    investmentDestination(intent).chainId !== 1 ||
    investmentDestination(intent).role !== "invest"
  )
    throw new Error("Native Ethereum intent required.");
  return addr(investmentDestination(intent).address);
}
export function parseFusionQuote(
  value: unknown,
  intent: EarnIntent,
  operationId: string,
  revision: number,
  input: string,
  minimum: string,
  overhead: string,
  now: number,
): LiquidityPlan & FusionProposal {
  const q = earnObject(value),
    owner = identity(intent);
  if (
    q.operationId !== operationId ||
    q.revision !== revision ||
    q.executable !== false ||
    earnAtoms(q.inputAtoms) !== input
  )
    throw new Error("Fusion quote binding changed.");
  addr(q.owner, owner);
  addr(q.confidentialAccount, intent.confidentialAddress);
  hash(q.orderHash);
  hash(q.extensionHash);
  const quoteId = hash(q.quoteId),
    quoted = number(q.quotedAt) * 1000,
    expires = number(q.expiresAt) * 1000,
    deadline = number(q.deadline);
  if (
    now - quoted > 60000 ||
    quoted > now + 5000 ||
    expires <= now ||
    expires > quoted + 60000 ||
    deadline <= Math.floor(now / 1000) ||
    deadline > Math.floor(now / 1000) + 600
  )
    throw new Error("Fusion quote expired.");
  const min = earnAtoms(q.minimumEthWei),
    gross = earnAtoms(q.grossEthWei),
    gas = BigInt(earnAtoms(q.resolverGasUnits)),
    price = BigInt(earnAtoms(q.resolverGasPriceWei)),
    cost = BigInt(earnAtoms(q.resolverGasCostWei)),
    profit = BigInt(earnAtoms(q.resolverProfitWei)),
    valueWei = BigInt(earnAtoms(q.inputValueWei));
  if (
    BigInt(min) < BigInt(minimum) ||
    BigInt(gross) < BigInt(min) ||
    gas === 0n ||
    price === 0n ||
    gas * price !== cost ||
    profit !== ceilDiv(cost, 10n) ||
    cost + profit > BigInt(overhead) ||
    valueWei - BigInt(gross) < cost + profit
  )
    throw new Error("Fusion economics changed.");
  const raw = earnObject(q.unsignedOrder),
    unsignedOrder: Record<string, string> = {};
  for (const field of ["salt", "makerTraits", "makingAmount", "takingAmount"])
    unsignedOrder[field] = earnAtoms(raw[field]);
  unsignedOrder.maker = addr(raw.maker, owner);
  unsignedOrder.receiver = addr(raw.receiver);
  if (
    ![owner.toLowerCase(), "0x399740157391a9f1bf4e9921a8834f9bc8f2678e"].includes(
      unsignedOrder.receiver.toLowerCase(),
    )
  )
    throw new Error("Fusion receiver changed.");
  unsignedOrder.makerAsset = addr(raw.makerAsset, earnProfiles["ethereum-usdc"].token);
  unsignedOrder.takerAsset = addr(raw.takerAsset, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  if (
    unsignedOrder.makingAmount !== input ||
    typeof q.extension !== "string" ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(q.extension) ||
    q.extension.length > 65536
  )
    throw new Error("Fusion order changed.");
  const proposal: FusionProposal = {
    ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
    ...investmentSlotField(intent),
    kind: "fusionEthOrder",
    operationId: id(operationId),
    revision: number(revision, 1),
    chainId: 1,
    expectedFrom: owner,
    confidentialAccount: intent.confidentialAddress,
    quoteId,
    inputAtoms: input,
    minimumEthWei: min,
    grossEthWei: gross,
    maximumResolverOverheadWei: overhead,
    deadline,
    fundingMode: "permit",
    unsignedOrder,
    extension: q.extension,
  };
  return {
    ...proposal,
    proposal,
    expiresAtMs: expires,
    resolverOverheadWei: (cost + profit).toString(),
  };
}
export function parseEthereumReturnPlan(
  value: unknown,
  intent: EarnIntent,
  operationId: string,
  revision: number,
  now: number,
): LiquidityPlan {
  const q = earnObject(value),
    owner = identity(intent);
  if (
    q.operationId !== operationId ||
    q.revision !== revision ||
    q.chainId !== 1 ||
    q.profileId !== intent.profileId ||
    q.readOnly !== true ||
    q.executionAvailable !== false ||
    !Number.isSafeInteger(q.providerFeeBps) ||
    Number(q.providerFeeBps) < 0 ||
    Number(q.providerFeeBps) > 100 ||
    !["returnUsdc", "returnEth"].includes(String(q.kind))
  )
    throw new Error("Return binding changed.");
  addr(q.owner, owner);
  addr(q.confidentialAccount, intent.confidentialAddress);
  addr(q.refundOwner, owner);
  hash(q.referenceBlockHash);
  hash(q.planHash);
  earnAtoms(q.referenceBlockNumber);
  const quoted = number(q.quotedAtMs),
    expires = number(q.expiresAtMs),
    reference = number(q.referenceTimestampMs);
  if (
    quoted > now + 5000 ||
    now - quoted > 60000 ||
    reference > now + 5000 ||
    now - reference > 60000 ||
    expires <= now ||
    expires > quoted + 45000 ||
    expires > reference + 60000
  )
    throw new Error("Return fees expired.");
  const amount = earnAtoms(q.amountAtoms),
    native = BigInt(earnAtoms(q.startingNativeWei)),
    usdc = earnAtoms(q.startingUsdc),
    fee = earnAtoms(q.maxFeePerGasWei),
    priority = earnAtoms(q.priorityFeePerGasWei),
    cost = earnAtoms(q.maximumGasCostWei),
    reserve = earnAtoms(q.withdrawalReserveWei),
    gas = number(q.gasLimit, 21000, 3000000),
    deadline = number(q.deadline);
  if (
    earnAtoms(q.startingShares) !== "0" ||
    earnAtoms(q.startingWeth) !== "0" ||
    BigInt(amount) === 0n ||
    BigInt(fee) === 0n ||
    BigInt(priority) > BigInt(fee) ||
    BigInt(cost) !== BigInt(gas) * BigInt(fee) ||
    deadline <= Math.floor(now / 1000) ||
    deadline > Math.floor(now / 1000) + 600
  )
    throw new Error("Return funding or position changed.");
  if (q.kind === "returnEth") {
    if (
      usdc !== "0" ||
      gas !== 21000 ||
      priority !== "0" ||
      reserve !== "0" ||
      BigInt(amount) + BigInt(cost) !== native
    )
      throw new Error("ETH return must sweep the current balance.");
  } else if (
    amount !== usdc ||
    native < BigInt(cost) + BigInt(reserve) ||
    BigInt(reserve) < 21000n * BigInt(fee)
  )
    throw new Error("USDC return would strand assets.");
  const proposal: ReturnProposal = {
    ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
    ...investmentSlotField(intent),
    kind: q.kind as ReturnProposal["kind"],
    operationId: id(operationId),
    revision: number(revision, 1),
    chainId: 1,
    expectedFrom: owner,
    confidentialAccount: intent.confidentialAddress,
    refundOwner: owner,
    quoteId: hash(q.quoteId),
    recipient: addr(q.recipient),
    amountAtoms: amount,
    nonce: number(q.nonce),
    deadline,
    gasLimit: gas,
    maxFeePerGasWei: fee,
    priorityFeePerGasWei: priority,
    maximumGasCostWei: cost,
    withdrawalReserveWei: reserve,
  };
  return { proposal, expiresAtMs: expires, minimumCreditAtoms: earnAtoms(q.minimumCreditAtoms) };
}
export function parseLiquidityOperations(value: unknown, intent: EarnIntent): LiquidityOperation[] {
  const owner = identity(intent);
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid liquidity journal.");
  const seen = new Set<string>();
  return value.map((v) => {
    const q = earnObject(v),
      operationId = id(q.operationId);
    assertInvestmentSlot(q, intent);
    if (
      seen.has(operationId) ||
      q.walletId !== intent.walletId ||
      q.chainId !== 1 ||
      !["fusionEthOrder", "fusionUsdcApproval", "returnUsdc", "returnEth"].includes(
        String(q.kind),
      ) ||
      ![
        "planned",
        "permitSaved",
        "signed",
        "unknown",
        "pending",
        "fusionFilled",
        "approvalFinalized",
        "awaitingSettlement",
        "credited",
        "minimumReceived",
        "cancelled",
        "reverted",
        "expired",
        "cancellationPending",
        "nonceCancelled",
      ].includes(String(q.status)) ||
      typeof q.blocked !== "boolean" ||
      typeof q.canResume !== "boolean"
    )
      throw new Error("Liquidity journal changed.");
    seen.add(operationId);
    const out: LiquidityOperation = {
      operationId,
      walletId: intent.walletId,
      revision: number(q.revision, 1),
      kind: q.kind as LiquidityKind,
      chainId: 1,
      from: addr(q.from, owner),
      amountAtoms: earnAtoms(q.amountAtoms),
      blocked: q.blocked,
      canResume: q.canResume,
      status: q.status as LiquidityOperation["status"],
    };
    const minimumReturnReceipt = parseMinimumReturn(q, intent);
    if (minimumReturnReceipt) {
      out.minimumReturnReceipt = minimumReturnReceipt;
      out.verifiedMinimumAtoms = minimumReturnReceipt.verifiedMinimumAtoms;
    }
    if (q.canCancelPending !== undefined) {
      if (typeof q.canCancelPending !== "boolean")
        throw new Error("Invalid cancellation authority.");
      out.canCancelPending = q.canCancelPending;
    }
    if (q.cancellationTransactionHashes !== undefined) {
      if (
        !Array.isArray(q.cancellationTransactionHashes) ||
        q.cancellationTransactionHashes.length > 256
      )
        throw new Error("Invalid cancellation history.");
      out.cancellationTransactionHashes = q.cancellationTransactionHashes.map(hash);
    }
    for (const field of ["transactionHash", "orderHash", "cancellationTransactionHash"] as const)
      if (q[field] !== undefined) out[field] = hash(q[field]);
    for (const field of ["actualFeeWei", "receivedEthWei"] as const)
      if (q[field] !== undefined) out[field] = earnAtoms(q[field]);
    if (q.settlement !== undefined) {
      const s = earnObject(q.settlement);
      if (
        s.authenticated !== true ||
        s.operationScoped !== true ||
        s.operationId !== operationId ||
        s.assetId !== monadConfidentialUsdcAssetId
      )
        throw new Error("Unauthenticated return credit.");
      addr(s.confidentialAddress, intent.confidentialAddress);
      if (s.status === "credited") out.creditedAtoms = earnAtoms(s.creditedAtoms);
    }
    if (out.status === "credited" && (!out.creditedAtoms || out.creditedAtoms === "0"))
      throw new Error("Missing verified return credit.");
    return out;
  });
}
