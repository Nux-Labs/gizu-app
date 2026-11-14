import { investmentDestination, assertInvestmentSlot } from "@/domain/earn/distribution";
import { parseMinimumReturn, type MinimumReturnReceipt } from "./minimumReturn";
import { parseEarnFeeProof, type EarnFeeProof } from "./policy";
import { earnObject, earnAtoms } from "./vaultExecution";
import type { EarnIntent } from "./types";
export const sourceUsdc = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  earnPaymaster = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402",
  earnEntryPoint = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  earnDelegation = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
export type SourceQuote = {
  providerFeeBps: number;
  feePolicy?: EarnFeeProof;
  operationId: string;
  revision: number;
  quoteId: string;
  recipient: string;
  chainId: 143;
  token: string;
  amountAtoms: string;
  confidentialAccount: string;
  refundOwner: string;
  expiresAt: number;
  minimumCreditAtoms: string;
};
export type SourceFeePlan = {
  amount: string;
  budget: string;
  feeCap: string;
  remainingBudget: string;
  expiresAtMs: number;
  userOperation: Record<string, string>;
};
export type SponsoredRequest = {
  walletId: string;
  proposal: {
    cycleIndex?: number;
    sourceAccountIndex?: number;
    fundingBatchId?: string;
    fundingBatchSize?: number;
    kind: "sourceFunding";
    operationId: string;
    revision: number;
    chainId: 143;
    profileChainId: 1 | 4663;
    expectedFrom: string;
    token: string;
    amountAtoms: string;
    nonce: string;
    deadline: number;
    maximumTokenFeeAtoms: string;
    budgetAtoms: string;
    withdrawalReserveAtoms: string;
    slippageBps: 0;
    recipient: string;
    quoteId: string;
    confidentialAccount: string;
    refundOwner: string;
  };
  userOperation: Record<string, string>;
};
export type SponsoredOperation = {
  requestedWithdrawalAtoms?: string;
  withdrawAllShares?: true;
  minimumRetainedUsdgAtoms?: string;
  withdrawalRequestId?: string;
  withdrawalOperationId?: string;
  returnBudgetAtoms?: string;
  investmentSlot?: number;
  fundingBatchId?: string;
  fundingBatchSize?: number;
  cycleIndex?: number;
  sourceAccountIndex?: number;
  operationId: string;
  walletId: string;
  revision: number;
  kind: "sourceFunding" | "hoodDeposit" | "hoodRedeemAll" | "hoodTokenReturn";
  chainId: 143 | 4663;
  from: string;
  amountAtoms: string;
  nonce: string;
  blocked: boolean;
  canResume: boolean;
  canCancelPreparation?: boolean;
  preparationCancellationDisclosure?: string;
  status:
    | "planned"
    | "authorizationSaved"
    | "unknown"
    | "signed"
    | "expired"
    | "nonceCancelled"
    | "pending"
    | "cancelled"
    | "reverted"
    | "invested"
    | "withdrawn"
    | "sourceFunded"
    | "returnSubmitted"
    | "residualShares"
    | "awaitingSettlement"
    | "minimumReceived"
    | "credited";
  userOperationHash?: string;
  signatureExpired?: boolean;
  transactionHash?: string;
  actualTokenFeeAtoms?: string;
  creditedAtoms?: string;
  verifiedMinimumAtoms?: string;
  minimumReturnReceipt?: MinimumReturnReceipt;
  residualShares?: string;
  redeemedUsdgAtoms?: string;
};

function decimalAtoms(value: string | null | undefined): string | null {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? value : null;
}

/** A historical return cannot describe a later deposit or redeem. */
export function latestPrivateReturn(
  rows: readonly SponsoredOperation[],
): SponsoredOperation | undefined {
  for (const row of [...rows].reverse()) {
    if (["cancelled", "reverted", "expired", "nonceCancelled"].includes(row.status)) continue;
    if (row.kind === "hoodDeposit" || row.kind === "hoodRedeemAll") return undefined;
    if (row.kind === "hoodTokenReturn") return row;
  }
  return undefined;
}

/** Native-confirmed return history survives subsequent spending of the private USDC. */
export function privateReturnConfirmed(rows: readonly SponsoredOperation[]): boolean {
  if (rows.some((row) => row.blocked)) return false;
  const returned = latestPrivateReturn(rows);
  if (!returned || !["credited", "minimumReceived"].includes(returned.status)) return false;
  const required = decimalAtoms(
    returned.status === "minimumReceived" ? returned.verifiedMinimumAtoms : returned.creditedAtoms,
  );
  return required !== null && BigInt(required) > 0n;
}
export type SourceFundingPlan = {
  fundingBatchId?: string;
  fundingBatchSize?: number;
  sourceAccountIndex?: number;
  sourceAddress?: string;
  quote: SourceQuote;
  fees: SourceFeePlan;
  budget: string;
  expiresAtMs: number;
};
export interface EarnSourceFundingService {
  available(): Promise<boolean>;
  planMany?(
    intent: EarnIntent,
    budget: string,
    sourceBalance: string,
    signal: AbortSignal,
  ): Promise<SourceFundingPlan[]>;
  plan(
    intent: EarnIntent,
    budget: string,
    sourceBalance: string,
    signal: AbortSignal,
    sourceAccountIndex?: number,
  ): Promise<SourceFundingPlan>;
  executeMany?(intent: EarnIntent, plans: SourceFundingPlan[]): Promise<SponsoredOperation[]>;
  resumeBatch?(intent: EarnIntent, fundingBatchId: string): Promise<SponsoredOperation[]>;
  execute(intent: EarnIntent, plan: SourceFundingPlan): Promise<SponsoredOperation>;
  list(intent: EarnIntent): Promise<SponsoredOperation[]>;
  resume(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  reconcileCredit(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  cancelUnsigned(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  cancel(): void;
}
function same(v: unknown, expected: string): v is string {
  return typeof v === "string" && v.toLowerCase() === expected.toLowerCase();
}
function address(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
}
function integer(v: unknown, min = 0): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}
function operationId(v: unknown): v is string {
  return typeof v === "string" && /^[-a-zA-Z0-9_]{1,128}$/.test(v);
}
function hash(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
}
function hex(v: unknown, max = 16384): v is string {
  return typeof v === "string" && /^0x[0-9a-f]*$/i.test(v) && v.length <= max;
}
export function parseSourceQuote(
  value: unknown,
  intent: EarnIntent,
  id: string,
  revision: number,
  amount: string,
  now: number,
): SourceQuote {
  const r = earnObject(value);
  if (
    intent.status !== "prepared" ||
    r.operationId !== id ||
    r.revision !== revision ||
    !operationId(id) ||
    !integer(revision, 1) ||
    r.chainId !== 143 ||
    !same(r.token, sourceUsdc) ||
    !same(r.confidentialAccount, intent.confidentialAddress) ||
    !same(r.refundOwner, intent.sourceAddress) ||
    !address(r.recipient) ||
    same(r.recipient, intent.sourceAddress) ||
    same(r.recipient, intent.confidentialAddress) ||
    r.amountAtoms !== amount ||
    !integer(r.expiresAt, 1) ||
    r.expiresAt <= Math.floor(now / 1000) ||
    typeof r.quoteId !== "string" ||
    r.quoteId.length < 1 ||
    r.quoteId.length > 256
  )
    throw new Error("Source quote changed or expired.");
  let feePolicy: EarnFeeProof | undefined;
  try {
    feePolicy = parseEarnFeeProof(r.feePolicy, r.providerFeeBps, "source");
  } catch {
    throw new Error("Source quote changed or expired.");
  }
  const minimumCreditAtoms = earnAtoms(r.minimumCreditAtoms);
  if (BigInt(minimumCreditAtoms) === 0n || BigInt(earnAtoms(amount)) === 0n)
    throw new Error("Invalid source quote amount.");
  return {
    providerFeeBps: r.providerFeeBps as number,
    ...(feePolicy ? { feePolicy } : {}),
    operationId: id,
    revision,
    quoteId: r.quoteId,
    recipient: r.recipient,
    chainId: 143,
    token: sourceUsdc,
    amountAtoms: amount,
    confidentialAccount: intent.confidentialAddress,
    refundOwner: intent.sourceAddress,
    expiresAt: r.expiresAt,
    minimumCreditAtoms,
  };
}
export function parseSourceFeePlan(
  value: unknown,
  intent: EarnIntent,
  recipient: string,
  amount: string,
  budget: string,
  now: number,
): SourceFeePlan {
  const r = earnObject(value);
  if (
    r.version !== "gizu-monad-funding-v1" ||
    r.chainId !== 143 ||
    !same(r.owner, intent.sourceAddress) ||
    !same(r.recipient, recipient) ||
    !same(r.token, sourceUsdc) ||
    r.amount !== amount ||
    r.budget !== budget ||
    !same(r.entryPoint, earnEntryPoint) ||
    !same(r.paymaster, earnPaymaster) ||
    !same(r.delegation, earnDelegation) ||
    r.executionAvailable !== false ||
    r.paymasterDataStatus !== "stub" ||
    !integer(r.timestampMs) ||
    now - r.timestampMs > 60000 ||
    r.timestampMs - now > 5000 ||
    !integer(r.expiresAtMs) ||
    r.expiresAtMs <= now ||
    r.expiresAtMs > r.timestampMs + 60000 ||
    !hash(r.referenceHash)
  )
    throw new Error("Source sponsorship binding changed or expired.");
  earnAtoms(r.referenceBlock);
  earnAtoms(r.authorizationNonce);
  if (typeof r.authorizationRequired !== "boolean")
    throw new Error("Missing native delegation state.");
  const feeCap = earnAtoms(r.feeCap),
    remainingBudget = earnAtoms(r.remainingBudget);
  if (
    BigInt(feeCap) === 0n ||
    BigInt(amount) + BigInt(feeCap) + BigInt(remainingBudget) !== BigInt(budget)
  )
    throw new Error("Source fee accounting changed.");
  const raw = earnObject(r.operation),
    userOperation: Record<string, string> = {};
  if (!same(raw.sender, intent.sourceAddress) || !same(raw.paymaster, earnPaymaster))
    throw new Error("Source operation owner changed.");
  for (const key of [
    "sender",
    "nonce",
    "callData",
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "paymaster",
    "paymasterData",
  ]) {
    if (!hex(raw[key])) throw new Error("Invalid unsigned source operation.");
    userOperation[key] = raw[key];
  }
  for (const key of [
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
    "maxFeePerGas",
  ]) {
    if (BigInt(userOperation[key]!) === 0n || BigInt(userOperation[key]!) >= 1n << 128n)
      throw new Error("Invalid sponsored gas bound.");
  }
  if (BigInt(userOperation.maxPriorityFeePerGas!) > BigInt(userOperation.maxFeePerGas!))
    throw new Error("Invalid source priority fee.");
  if (raw.factory !== undefined) {
    if (raw.factory !== "0x7702" || raw.factoryData !== "0x")
      throw new Error("Unexpected source account factory.");
    userOperation.factory = "0x7702";
    userOperation.factoryData = "0x";
  }
  userOperation.signature = "0x";
  return { amount, budget, feeCap, remainingBudget, expiresAtMs: r.expiresAtMs, userOperation };
}
export function sourceFundingProposal(
  intent: EarnIntent,
  quote: SourceQuote,
  fees: SourceFeePlan,
  budget: string,
  now: number,
  sourceAccountIndex?: number,
): SponsoredRequest {
  parseSourceQuote(quote, intent, quote.operationId, quote.revision, fees.amount, now);
  if (
    intent.status !== "prepared" ||
    fees.budget !== budget ||
    fees.expiresAtMs <= now ||
    BigInt(fees.remainingBudget) < 10000n ||
    !same(fees.userOperation.sender, intent.sourceAddress) ||
    !same(fees.userOperation.paymaster, earnPaymaster)
  )
    throw new Error("Source budget changed. Refresh fees before authorizing.");
  return {
    walletId: intent.walletId,
    proposal: {
      ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
      ...(sourceAccountIndex !== undefined ? { sourceAccountIndex } : {}),
      kind: "sourceFunding",
      operationId: quote.operationId,
      revision: quote.revision,
      chainId: 143,
      profileChainId: intent.profileId === "ethereum-usdc" ? 1 : 4663,
      expectedFrom: intent.sourceAddress,
      token: sourceUsdc,
      amountAtoms: fees.amount,
      nonce: fees.userOperation.nonce!,
      deadline: Math.min(quote.expiresAt, Math.floor(now / 1000) + 180),
      maximumTokenFeeAtoms: fees.feeCap,
      budgetAtoms: budget,
      withdrawalReserveAtoms: "10000",
      slippageBps: 0,
      recipient: quote.recipient,
      quoteId: quote.quoteId,
      confidentialAccount: intent.confidentialAddress,
      refundOwner: intent.sourceAddress,
    },
    userOperation: { ...fees.userOperation },
  };
}
export function parseSponsoredOperations(value: unknown, intent: EarnIntent): SponsoredOperation[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid native sponsorship journal.");
  const seen = new Set<string>();
  return value.map((v) => {
    const r = earnObject(v),
      kind = r.kind;
    if (
      !operationId(r.operationId) ||
      seen.has(r.operationId) ||
      r.walletId !== intent.walletId ||
      !integer(r.revision, 1) ||
      !hex(r.nonce, 18) ||
      typeof r.blocked !== "boolean" ||
      typeof r.canResume !== "boolean" ||
      !["sourceFunding", "hoodDeposit", "hoodRedeemAll", "hoodTokenReturn"].includes(
        String(kind),
      ) ||
      ![
        "planned",
        "authorizationSaved",
        "unknown",
        "signed",
        "expired",
        "nonceCancelled",
        "pending",
        "cancelled",
        "reverted",
        "invested",
        "withdrawn",
        "sourceFunded",
        "returnSubmitted",
        "residualShares",
        "awaitingSettlement",
        "minimumReceived",
        "credited",
      ].includes(String(r.status))
    )
      throw new Error("Native sponsorship journal changed.");
    seen.add(r.operationId);
    const source = kind === "sourceFunding";
    if (!source) assertInvestmentSlot(r, intent);
    const selectedSource = r.sourceAccountIndex !== undefined;
    if (selectedSource && (!integer(r.sourceAccountIndex) || !address(r.from)))
      throw new Error("Invalid native funding account.");
    if ((r.cycleIndex ?? 0) !== (intent.cycleIndex ?? 0))
      throw new Error("Native earn cycle changed.");
    const from =
        source && selectedSource
          ? (r.from as string)
          : source
            ? intent.sourceAddress
            : investmentDestination(intent).address,
      chainId = source ? 143 : 4663;
    if (
      r.chainId !== chainId ||
      !same(r.from, from) ||
      (!source && intent.profileId !== "robinhood-usdg")
    )
      throw new Error("Native sponsored wallet changed.");
    if (
      r.fundingBatchId !== undefined &&
      (typeof r.fundingBatchId !== "string" ||
        !/^[-a-zA-Z0-9_:]{1,128}$/.test(r.fundingBatchId) ||
        !integer(r.fundingBatchSize, 1))
    )
      throw new Error("Invalid native funding batch.");
    const amountAtoms = earnAtoms(r.amountAtoms),
      optional: Partial<SponsoredOperation> = {};
    const minimumReturnReceipt = parseMinimumReturn(r, intent);
    if (minimumReturnReceipt) {
      optional.minimumReturnReceipt = minimumReturnReceipt;
      optional.verifiedMinimumAtoms = minimumReturnReceipt.verifiedMinimumAtoms;
    }
    if (r.canCancelPreparation !== undefined) {
      if (typeof r.canCancelPreparation !== "boolean")
        throw new Error("Invalid preparation cancellation state.");
      optional.canCancelPreparation = r.canCancelPreparation;
    }
    if (r.signatureExpired !== undefined) {
      if (r.signatureExpired !== true) throw new Error("Invalid saved signature expiry.");
      optional.signatureExpired = true;
    }
    if (r.preparationCancellationDisclosure !== undefined) {
      if (
        typeof r.preparationCancellationDisclosure !== "string" ||
        r.preparationCancellationDisclosure.length > 512
      )
        throw new Error("Invalid preparation cancellation disclosure.");
      optional.preparationCancellationDisclosure = r.preparationCancellationDisclosure;
    }
    for (const key of ["userOperationHash", "transactionHash"] as const) {
      if (r[key] !== undefined) {
        if (!hash(r[key])) throw new Error("Invalid native receipt reference.");
        optional[key] = r[key];
      }
    }
    for (const key of ["actualTokenFeeAtoms", "creditedAtoms", "residualShares"] as const) {
      if (r[key] !== undefined) optional[key] = earnAtoms(r[key]);
    }
    for (const key of ["withdrawalRequestId", "withdrawalOperationId"] as const) {
      if (r[key] !== undefined) {
        if (!operationId(r[key])) throw new Error("Invalid native withdrawal reference.");
        optional[key] = r[key];
      }
    }
    for (const key of ["requestedWithdrawalAtoms", "returnBudgetAtoms"] as const) {
      if (r[key] !== undefined) {
        const atoms = earnAtoms(r[key]);
        if (atoms === "0") throw new Error("Invalid native withdrawal amount.");
        optional[key] = atoms;
      }
    }
    if (r.withdrawAllShares !== undefined) {
      if (r.withdrawAllShares !== true) throw new Error("Invalid native Max mode.");
      optional.withdrawAllShares = true;
    }
    if (r.minimumRetainedUsdgAtoms !== undefined)
      optional.minimumRetainedUsdgAtoms = earnAtoms(r.minimumRetainedUsdgAtoms);
    if (r.redeemedUsdgAtoms !== undefined) {
      const redeemed = earnAtoms(r.redeemedUsdgAtoms);
      if (redeemed === "0") throw new Error("Invalid redeemed USDG amount.");
      optional.redeemedUsdgAtoms = redeemed;
    }
    if (
      r.status === "credited" &&
      (BigInt(optional.creditedAtoms ?? "0") === 0n || !optional.transactionHash)
    )
      throw new Error("Missing authenticated operation credit.");
    return {
      operationId: r.operationId,
      walletId: intent.walletId,
      revision: r.revision,
      ...(!source && r.investmentSlot !== undefined
        ? { investmentSlot: r.investmentSlot as number }
        : {}),
      kind: kind as SponsoredOperation["kind"],
      chainId,
      from,
      amountAtoms,
      nonce: r.nonce,
      blocked: r.blocked,
      canResume: r.canResume,
      status: r.status as SponsoredOperation["status"],
      ...(selectedSource ? { sourceAccountIndex: r.sourceAccountIndex as number } : {}),
      ...(r.cycleIndex !== undefined ? { cycleIndex: r.cycleIndex as number } : {}),
      ...(r.fundingBatchId !== undefined
        ? {
            fundingBatchId: String(r.fundingBatchId),
            fundingBatchSize: r.fundingBatchSize as number,
          }
        : {}),
      ...optional,
    };
  });
}

export type SourceFundingPreview = {
  amountAtoms: string;
  quoteAvailable: boolean;
  minimumCreditAtoms: string | null;
  providerFeeBps: number | null;
  appFees: { recipient: string; fee: number }[];
  referral: string | null;
  maximumGasAtoms: string;
  budget: string;
  expiresAtMs: number;
  blockers: string[];
};
export class SourceFundingBlocked extends Error {
  constructor(readonly preview: SourceFundingPreview) {
    super("Funding authorization is blocked. No funds moved.");
  }
}
export function parseSourcePreview(
  value: unknown,
  intent: EarnIntent,
  amount: string,
  budget: string,
  maximumGasAtoms: string,
  now: number,
): SourceFundingPreview {
  const r = earnObject(value);
  if (
    r.version !== "gizu-source-preview-v1" ||
    r.executionAvailable !== false ||
    (r.quoteAvailable !== undefined && typeof r.quoteAvailable !== "boolean") ||
    !same(r.sourceOwner, intent.sourceAddress) ||
    !same(r.confidentialAccount, intent.confidentialAddress) ||
    r.amountAtoms !== amount ||
    !integer(r.quotedAtMs) ||
    now - r.quotedAtMs > 60000 ||
    r.quotedAtMs > now + 5000 ||
    !integer(r.expiresAtMs) ||
    r.expiresAtMs <= now ||
    r.expiresAtMs <= r.quotedAtMs ||
    r.expiresAtMs > r.quotedAtMs + 60000 ||
    !Array.isArray(r.blockers) ||
    r.blockers.length === 0 ||
    r.blockers.some(
      (b) =>
        ![
          "EARN_AURORA_FEE_UNQUALIFIED",
          "EARN_SETTLEMENT_UNQUALIFIED",
          "EARN_RECOVERY_UNAVAILABLE",
          "EARN_AURORA_ROUTE_UNAVAILABLE",
        ].includes(b),
    )
  )
    throw new Error("Unsigned funding preview could not be verified.");
  if (r.quoteAvailable === false) {
    if (
      r.minimumCreditAtoms !== null ||
      r.providerFeeBps !== null ||
      !Array.isArray(r.appFees) ||
      r.appFees.length !== 0 ||
      r.referral !== null ||
      !(r.blockers as string[]).includes("EARN_AURORA_ROUTE_UNAVAILABLE")
    )
      throw new Error("Invalid unavailable-route preview.");
    return {
      quoteAvailable: false,
      amountAtoms: amount,
      minimumCreditAtoms: null,
      providerFeeBps: null,
      appFees: [],
      referral: null,
      maximumGasAtoms,
      budget,
      expiresAtMs: r.expiresAtMs,
      blockers: r.blockers as string[],
    };
  }
  const proof = parseEarnFeeProof(
    {
      version: "preview",
      route: "source",
      totalBps: r.providerFeeBps,
      appFees: r.appFees,
      referral: r.referral,
      integratorFeeBps: 0,
      applicationFeeAtoms: "0",
    },
    r.providerFeeBps,
    "source",
  )!;
  const minimumCreditAtoms = earnAtoms(r.minimumCreditAtoms);
  if (BigInt(minimumCreditAtoms) <= 0n || BigInt(minimumCreditAtoms) > BigInt(amount))
    throw new Error("Invalid funding preview credit.");
  return {
    quoteAvailable: true,
    amountAtoms: amount,
    minimumCreditAtoms,
    providerFeeBps: proof.totalBps,
    appFees: proof.appFees,
    referral: proof.referral,
    maximumGasAtoms,
    budget,
    expiresAtMs: r.expiresAtMs,
    blockers: r.blockers as string[],
  };
}

export type PublicFundingLeg = {
  sourceIndex: number;
  address: string;
  budgetAtoms: string;
  amountAtoms: string;
  feeAtoms: string;
  reserveAtoms: string;
};
export type PublicFundingPlan = {
  fundingBatchId?: string;
  requestedBudgetAtoms: string;
  totalAmountAtoms: string;
  totalFeeAtoms: string;
  totalReserveAtoms: string;
  legs: PublicFundingLeg[];
};
export function parsePublicFundingPlan(
  value: unknown,
  requestedBudgetAtoms: string,
): PublicFundingPlan {
  const raw = earnObject(value);
  if (
    raw.fundingBatchId !== undefined &&
    (typeof raw.fundingBatchId !== "string" || !/^[-a-zA-Z0-9_:]{1,128}$/.test(raw.fundingBatchId))
  )
    throw new Error("Invalid native funding batch.");
  if (
    raw.requestedBudgetAtoms !== earnAtoms(requestedBudgetAtoms) ||
    !Array.isArray(raw.legs) ||
    raw.legs.length === 0 ||
    raw.legs.length > 256
  )
    throw new Error("Invalid native funding selection.");
  if (raw.legs.length > 1 && !raw.fundingBatchId)
    throw new Error("Native funding batch identity required.");
  const indices = new Set<number>();
  const addresses = new Set<string>();
  let amount = 0n,
    fee = 0n,
    reserve = 0n,
    budget = 0n;
  const legs = raw.legs.map((value) => {
    const leg = earnObject(value);
    if (
      !integer(leg.sourceIndex) ||
      indices.has(leg.sourceIndex) ||
      !address(leg.address) ||
      addresses.has(leg.address.toLowerCase())
    )
      throw new Error("Invalid native funding account.");
    indices.add(leg.sourceIndex);
    addresses.add(leg.address.toLowerCase());
    const budgetAtoms = earnAtoms(leg.budgetAtoms),
      amountAtoms = earnAtoms(leg.amountAtoms),
      feeAtoms = earnAtoms(leg.feeAtoms),
      reserveAtoms = earnAtoms(leg.reserveAtoms);
    if (
      BigInt(amountAtoms) < 10n ||
      BigInt(feeAtoms) === 0n ||
      BigInt(reserveAtoms) < 10000n ||
      BigInt(amountAtoms) + BigInt(feeAtoms) + BigInt(reserveAtoms) !== BigInt(budgetAtoms)
    )
      throw new Error("Native per-account funding budget changed.");
    amount += BigInt(amountAtoms);
    fee += BigInt(feeAtoms);
    reserve += BigInt(reserveAtoms);
    budget += BigInt(budgetAtoms);
    return {
      sourceIndex: leg.sourceIndex,
      address: leg.address,
      budgetAtoms,
      amountAtoms,
      feeAtoms,
      reserveAtoms,
    };
  });
  if (
    budget !== BigInt(requestedBudgetAtoms) ||
    earnAtoms(raw.totalAmountAtoms) !== amount.toString() ||
    earnAtoms(raw.totalFeeAtoms) !== fee.toString() ||
    earnAtoms(raw.totalReserveAtoms) !== reserve.toString()
  )
    throw new Error("Native total funding budget changed.");
  return {
    ...(raw.fundingBatchId ? { fundingBatchId: raw.fundingBatchId as string } : {}),
    requestedBudgetAtoms,
    totalAmountAtoms: amount.toString(),
    totalFeeAtoms: fee.toString(),
    totalReserveAtoms: reserve.toString(),
    legs,
  };
}
