import { investmentDestination, investmentSlotField } from "@/domain/earn/distribution";
import { parseEarnFeeProof, type EarnFeeProof } from "./policy";
import { earnProfiles, earnReturnAddress, type EarnIntent } from "./types";
import { ceilDiv } from "./policy";
import { earnAtoms, earnObject } from "./vaultExecution";
import {
  earnDelegation,
  earnEntryPoint,
  earnPaymaster,
  type SponsoredOperation,
} from "./sourceFunding";
export const hoodRouter = "0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe";
export const hoodWrappedNative = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const hoodOriginAsset = "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near";
export type RobinhoodKind = "hoodDeposit" | "hoodRedeemAll" | "hoodTokenReturn";
export type RobinhoodRoute = {
  quoteId: string;
  recipient: string;
  confidentialAccount: string;
  refundOwner: string;
  expiresAt: number;
  minimumCreditAtoms: string;
  providerFeeBps: number;
  feePolicy?: EarnFeeProof;
};
export type RobinhoodPlan = {
  requestedWithdrawalAtoms?: string;
  withdrawAllShares?: true;
  withdrawalRequestId?: string;
  remainingShares?: string;
  withdrawalOperationId?: string;
  returnBudgetAtoms?: string;
  kind: RobinhoodKind;
  operationId: string;
  revision: number;
  owner: string;
  amountAtoms: string;
  budgetAtoms: string;
  maximumTokenFeeAtoms: string;
  finalQuoteCapAtoms: string;
  withdrawalReserveAtoms: string;
  retainedAtoms: string;
  shareDecimals: number;
  deadline: number;
  expiresAtMs: number;
  userOperation: Record<string, string>;
  route?: RobinhoodRoute;
  maximumResidualUsdcAtoms?: string;
  previewRedeemedUsdg?: string;
};
export type RobinhoodRequest = {
  walletId: string;
  proposal: {
    requestedWithdrawalAtoms?: string;
    withdrawAllShares?: true;
    withdrawalRequestId?: string;
    withdrawalOperationId?: string;
    returnBudgetAtoms?: string;
    cycleIndex?: number;
    investmentSlot?: number;
    kind: RobinhoodKind;
    operationId: string;
    revision: number;
    chainId: 4663;
    profileChainId: 4663;
    expectedFrom: string;
    token: string;
    vault: string;
    router: string;
    amountAtoms: string;
    nonce: string;
    deadline: number;
    maximumTokenFeeAtoms: string;
    budgetAtoms: string;
    withdrawalReserveAtoms: string;
    slippageBps: 0 | 10;
    recipient?: string;
    quoteId?: string;
    confidentialAccount?: string;
    refundOwner?: string;
  };
  userOperation: Record<string, string>;
};
export interface EarnRobinhoodService {
  available(): Promise<boolean>;
  withdrawalBalances?(
    intents: EarnIntent[],
    signal: AbortSignal,
  ): Promise<{ owner: string; shares: string; assetsAtoms: string; checkedAt: number }[]>;
  plan(
    intent: EarnIntent,
    kind: RobinhoodKind,
    signal: AbortSignal,
    options?: RobinhoodPlanOptions,
  ): Promise<RobinhoodPlan>;
  execute(intent: EarnIntent, plan: RobinhoodPlan): Promise<SponsoredOperation>;
  finishWithdrawal?(
    intent: EarnIntent,
    redeem: SponsoredOperation,
    signal: AbortSignal,
  ): Promise<{ row: SponsoredOperation; signed: SponsoredOperation | null }>;
  list(intent: EarnIntent): Promise<SponsoredOperation[]>;
  resume(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  reconcileCredit(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  markReturnReceived?(intent: EarnIntent, operationId: string): Promise<void>;
  cancelUnsigned(intent: EarnIntent, op: SponsoredOperation): Promise<SponsoredOperation>;
  cancel(): void;
}
export type RobinhoodPlanOptions = Pick<
  RobinhoodPlan,
  | "requestedWithdrawalAtoms"
  | "withdrawAllShares"
  | "withdrawalRequestId"
  | "withdrawalOperationId"
  | "returnBudgetAtoms"
> & { minimumRetainedUsdgAtoms?: string };
function same(v: unknown, expected: string): v is string {
  return typeof v === "string" && v.toLowerCase() === expected.toLowerCase();
}
function address(v: unknown, expected?: string): string {
  if (
    typeof v !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(v) ||
    /^0x0{40}$/i.test(v) ||
    (expected && !same(v, expected))
  )
    throw new Error("Robinhood account or contract changed.");
  return v;
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Invalid Robinhood reference.");
  return v;
}
function hash(v: unknown) {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/i.test(v) || /^0x0{64}$/i.test(v))
    throw new Error("Invalid Robinhood reference hash.");
}
function id(v: string) {
  if (!/^[-a-zA-Z0-9_]{1,128}$/.test(v)) throw new Error("Invalid Robinhood operation.");
  return v;
}
function owner(intent: EarnIntent) {
  if (
    intent.status !== "prepared" ||
    intent.profileId !== "robinhood-usdg" ||
    investmentDestination(intent).role !== "invest" ||
    investmentDestination(intent).chainId !== 4663
  )
    throw new Error("Robinhood execution requires a prepared native intent.");
  return address(investmentDestination(intent).address);
}
function unsigned(value: unknown, expected: string) {
  const raw = earnObject(value),
    out: Record<string, string> = {};
  address(raw.sender, expected);
  address(raw.paymaster, earnPaymaster);
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
    const v = raw[key];
    if (typeof v !== "string" || !/^0x[0-9a-f]+$/i.test(v) || v.length > 16384)
      throw new Error("Invalid unsigned Robinhood operation.");
    out[key] = v;
  }
  for (const key of [
    "nonce",
    "callGasLimit",
    "verificationGasLimit",
    "preVerificationGas",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
  ]) {
    const v = out[key]!;
    if (
      !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) ||
      BigInt(v) >= 1n << 128n ||
      (key !== "nonce" && key !== "maxPriorityFeePerGas" && BigInt(v) === 0n)
    )
      throw new Error("Invalid sponsored gas or nonce.");
    if (key.endsWith("GasLimit") || key === "preVerificationGas")
      if (BigInt(v) > 20000000n) throw new Error("Unbounded Robinhood gas.");
  }
  if (
    BigInt(out.nonce!) >= 1n << 64n ||
    BigInt(out.maxPriorityFeePerGas!) > BigInt(out.maxFeePerGas!)
  )
    throw new Error("Invalid sponsored fee or EntryPoint nonce.");
  if (raw.factory !== undefined || raw.factoryData !== undefined) {
    if (raw.factory !== "0x7702" || raw.factoryData !== "0x")
      throw new Error("Unsupported account factory.");
    out.factory = "0x7702";
    out.factoryData = "0x";
  }
  out.signature = "0x";
  return out;
}
function simulation(v: unknown) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 4)
    throw new Error("Missing measured fork calls.");
  for (const x of v) {
    const r = earnObject(x);
    if (BigInt(earnAtoms(r.estimatedGas)) === 0n || BigInt(earnAtoms(r.actualGas)) === 0n)
      throw new Error("Missing measured fork gas.");
  }
}
/** Public checks are a review aid. Native independently derives roles, reads state and signs. */
export function parseRobinhoodPlan(
  value: unknown,
  intent: EarnIntent,
  kind: RobinhoodKind,
  operationId: string,
  revision: number,
  now: number,
): RobinhoodPlan {
  const r = earnObject(value),
    expected = owner(intent),
    profile = earnProfiles["robinhood-usdg"];
  if (
    r.operationId !== id(operationId) ||
    r.revision !== integer(revision, 1) ||
    r.profileId !== "robinhood-usdg" ||
    r.chainId !== 4663 ||
    r.tokenDecimals !== 6 ||
    r.readOnly !== true ||
    r.executionAvailable !== false ||
    r.paymasterDataStatus !== "stub"
  )
    throw new Error("Robinhood plan binding changed.");
  for (const [v, e] of [
    [r.owner, expected],
    [r.token, profile.token],
    [r.vault, profile.vault],
    [r.router, hoodRouter],
    [r.wrappedNative, hoodWrappedNative],
    [r.entryPoint, earnEntryPoint],
    [r.paymaster, earnPaymaster],
  ] as const)
    address(v, e);
  hash(r.planHash);
  hash(r.referenceBlockHash);
  earnAtoms(r.referenceBlockNumber);
  earnAtoms(r.nonce);
  const quoted = integer(r.quotedAtMs),
    reference = integer(r.referenceTimestampMs),
    expires = integer(r.expiresAtMs),
    deadline = integer(Number(earnAtoms(r.deadline)));
  if (
    quoted > now + 5000 ||
    now - quoted > 60000 ||
    reference > now + 5000 ||
    now - reference > 60000 ||
    expires <= now ||
    expires > quoted + 45000 ||
    expires > reference + 60000 ||
    deadline <= Math.floor(now / 1000) ||
    deadline > Math.floor(now / 1000) + 600
  )
    throw new Error("Robinhood plan expired. Refresh before authorizing.");
  const balances = earnObject(r.startingBalances),
    budget = earnAtoms(balances.usdg),
    shares = earnAtoms(balances.shares),
    auth = earnObject(r.authorization),
    userOperation = unsigned(r.operation, expected),
    fees = earnObject(r.fees);
  if (
    earnAtoms(balances.nativeEth) !== "0" ||
    earnAtoms(balances.wrappedNative) !== "0" ||
    auth.chainId !== 4663 ||
    typeof auth.required !== "boolean" ||
    !same(auth.delegation, earnDelegation) ||
    earnAtoms(auth.nonce) !== r.nonce ||
    fees.priceHeadroomBps !== 1000 ||
    fees.operationBudgetHeadroomBps !== 500
  )
    throw new Error("Robinhood asset or sponsorship policy changed.");
  const fee = earnAtoms(kind === "hoodDeposit" ? fees.maximumFeeWei : fees.maxFeePerGasWei),
    priority = earnAtoms(kind === "hoodDeposit" ? fees.priorityFeeWei : fees.priorityFeePerGasWei);
  if (
    BigInt(userOperation.maxFeePerGas!) !== BigInt(fee) ||
    BigInt(userOperation.maxPriorityFeePerGas!) !== BigInt(priority)
  )
    throw new Error("Robinhood gas prices changed.");
  let amount: string,
    cap: string,
    maximum: string,
    reserve = "0",
    retained: string,
    route: RobinhoodRoute | undefined,
    residual: string | undefined,
    redeemed: string | undefined;
  if (kind === "hoodDeposit") {
    const sim = earnObject(r.simulation);
    simulation(sim.deposit);
    simulation(sim.withdrawal);
    if (
      r.policyVersion !== "robinhood-usdg-v1-price10-budget5-withdraw260" ||
      r.simulationAvailable !== true ||
      shares !== "0" ||
      fees.withdrawalReserveMultiplierBps !== 26000 ||
      sim.withdrawalPurpose !== "reserve-only-isolated-fork" ||
      sim.fundingAssumption !== "real-USDG-balance-with-fork-only-native-gas-override" ||
      sim.overrideScope !== "verified-post-deposit-storage-only"
    )
      throw new Error("Robinhood deposit reserve policy changed.");
    amount = earnAtoms(r.depositAmount);
    cap = earnAtoms(r.depositQuoteCap);
    maximum = earnAtoms(r.depositFeeBudget);
    reserve = earnAtoms(r.withdrawalReserve);
    retained = earnAtoms(r.retainedLiquidUsdg);
    if (
      BigInt(maximum) < BigInt(cap) ||
      BigInt(reserve) !== ceilDiv(BigInt(earnAtoms(r.withdrawalQuoteCap)) * 260n, 100n) ||
      BigInt(reserve) === 0n ||
      BigInt(amount) + BigInt(maximum) + BigInt(reserve) !== BigInt(budget) ||
      BigInt(retained) !== BigInt(maximum) + BigInt(reserve)
    )
      throw new Error("Robinhood deposit balance or reserve changed.");
  } else {
    simulation(r.simulation);
    amount = earnAtoms(r.amountAtoms);
    maximum = earnAtoms(r.maximumTokenFeeAtoms);
    cap = earnAtoms(r.finalQuoteCapAtoms);
    retained = (BigInt(budget) - (kind === "hoodRedeemAll" ? 0n : BigInt(amount))).toString();
    if (
      r.kind !== kind ||
      r.retainedAfterActionAtoms !== "0" ||
      BigInt(cap) > BigInt(maximum) ||
      BigInt(maximum) > BigInt(budget)
    )
      throw new Error("Robinhood exit budget changed.");
    if (kind === "hoodRedeemAll") {
      if (r.requestedWithdrawalAtoms !== undefined) {
        if (
          !r.withdrawalRequestId ||
          BigInt(earnAtoms(r.requestedWithdrawalAtoms)) === 0n ||
          BigInt(amount) > BigInt(shares)
        )
          throw new Error("Requested withdrawal shares changed.");
        if (
          r.withdrawAllShares !== undefined &&
          (r.withdrawAllShares !== true || amount !== shares)
        )
          throw new Error("Max withdrawal shares changed.");
      } else if (amount !== shares) throw new Error("Withdrawal must redeem all current shares.");
      if (
        r.withdrawalRequestId !== undefined &&
        (typeof r.withdrawalRequestId !== "string" ||
          id(r.withdrawalRequestId) !== r.withdrawalRequestId ||
          earnAtoms(r.remainingShares) !== (BigInt(shares) - BigInt(amount)).toString())
      )
        throw new Error("Withdrawal portion changed.");
      if (r.returnsQuoted !== false || r.minimumAssetsGuard !== false)
        throw new Error("Withdrawal policy changed.");
      redeemed = earnAtoms(r.previewRedeemedUsdg);
    } else {
      if (
        (r.withdrawalOperationId === undefined && shares !== "0") ||
        BigInt(amount) + BigInt(maximum) > BigInt(budget) ||
        r.quotePolicy !== "one-immutable-quote-after-fee-probe" ||
        r.residualTargetMet !== true
      )
        throw new Error("Return requires zero shares and an exact fee budget.");
      let residualBudget = retained;
      reserve = earnAtoms(r.withdrawalReserveAtoms ?? "0");
      if (BigInt(amount) + BigInt(maximum) + BigInt(reserve) > BigInt(budget))
        throw new Error("The remaining investment reserve is not funded.");
      if (r.withdrawalOperationId !== undefined || r.returnBudgetAtoms !== undefined) {
        if (typeof r.withdrawalOperationId !== "string")
          throw new Error("Missing withdrawal source.");
        id(r.withdrawalOperationId);
        const sourceBudget = earnAtoms(r.returnBudgetAtoms);
        if (
          BigInt(sourceBudget) > BigInt(budget) ||
          BigInt(amount) + BigInt(maximum) > BigInt(sourceBudget)
        )
          throw new Error("Return exceeds withdrawal proceeds.");
        residualBudget = (BigInt(sourceBudget) - BigInt(amount)).toString();
      }
      const p = earnObject(r.price),
        price = BigInt(earnAtoms(p.tokenPriceMicroUsdc)),
        observed = integer(p.observedAtMs);
      residual = earnAtoms(r.maximumResidualUsdcAtoms);
      if (
        p.maximumAgeMs !== 300000 ||
        observed > now + 60000 ||
        now - observed > 300000 ||
        price === 0n ||
        BigInt(residual) !== ceilDiv(BigInt(residualBudget) * price, 1000000n) ||
        BigInt(residual) >= 500000n
      )
        throw new Error("Return residual valuation changed or expired.");
      const q = earnObject(r.route),
        recipient = address(q.recipient),
        expiry = integer(q.expiresAt, 1),
        minimum = earnAtoms(q.minimumCreditAtoms);
      hash(q.quoteId);
      hash(q.authenticatedBodyHash);
      if (
        q.operationId !== operationId ||
        q.revision !== revision ||
        q.chainId !== 4663 ||
        !same(q.token, profile.token) ||
        q.amountAtoms !== amount ||
        !same(q.confidentialAccount, earnReturnAddress(intent)) ||
        !same(q.refundOwner, expected) ||
        same(recipient, expected) ||
        same(recipient, earnReturnAddress(intent)) ||
        !Number.isSafeInteger(q.providerFeeBps) ||
        Number(q.providerFeeBps) < 0 ||
        Number(q.providerFeeBps) > 100 ||
        q.originAsset !== hoodOriginAsset ||
        expiry < deadline ||
        expiry <= Math.floor(now / 1000) ||
        expiry > Math.floor(now / 1000) + 600 ||
        BigInt(minimum) === 0n
      )
        throw new Error("Return quote changed or expired.");
      route = {
        quoteId: q.quoteId as string,
        recipient,
        confidentialAccount: earnReturnAddress(intent),
        refundOwner: expected,
        expiresAt: expiry,
        minimumCreditAtoms: minimum,
        providerFeeBps: q.providerFeeBps as number,
        feePolicy: parseEarnFeeProof(q.feePolicy, q.providerFeeBps, "returnRobinhood"),
      };
    }
  }
  if (BigInt(amount) === 0n || BigInt(cap) === 0n || BigInt(maximum) === 0n)
    throw new Error("Invalid Robinhood amount or fee.");
  return {
    kind,
    operationId,
    revision,
    owner: expected,
    amountAtoms: amount,
    budgetAtoms: budget,
    maximumTokenFeeAtoms: maximum,
    finalQuoteCapAtoms: cap,
    withdrawalReserveAtoms: reserve,
    retainedAtoms: retained,
    shareDecimals: integer(r.shareDecimals, 0, 18),
    deadline,
    expiresAtMs: Math.min(expires, route ? route.expiresAt * 1000 : Infinity),
    userOperation,
    ...(route ? { route } : {}),
    ...(residual ? { maximumResidualUsdcAtoms: residual } : {}),
    ...(redeemed ? { previewRedeemedUsdg: redeemed } : {}),
    ...(r.requestedWithdrawalAtoms !== undefined
      ? {
          requestedWithdrawalAtoms: earnAtoms(r.requestedWithdrawalAtoms),
          ...(r.withdrawAllShares === true ? { withdrawAllShares: true as const } : {}),
        }
      : {}),
    ...(r.withdrawalRequestId !== undefined
      ? {
          withdrawalRequestId: id(String(r.withdrawalRequestId)),
          remainingShares: earnAtoms(r.remainingShares),
        }
      : {}),
    ...(r.withdrawalOperationId !== undefined
      ? {
          withdrawalOperationId: id(String(r.withdrawalOperationId)),
          returnBudgetAtoms: earnAtoms(r.returnBudgetAtoms),
        }
      : {}),
  };
}
export function robinhoodProposal(
  plan: RobinhoodPlan,
  intent: EarnIntent,
  now: number,
): RobinhoodRequest {
  if (
    !same(plan.owner, owner(intent)) ||
    plan.expiresAtMs <= now ||
    plan.deadline <= Math.floor(now / 1000)
  )
    throw new Error("Robinhood plan expired. Refresh before authorizing.");
  const op = unsigned(plan.userOperation, plan.owner),
    route = plan.route;
  return {
    walletId: intent.walletId,
    proposal: {
      ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
      ...investmentSlotField(intent),
      kind: plan.kind,
      operationId: id(plan.operationId),
      revision: integer(plan.revision, 1),
      chainId: 4663,
      profileChainId: 4663,
      expectedFrom: plan.owner,
      token: earnProfiles["robinhood-usdg"].token,
      vault: earnProfiles["robinhood-usdg"].vault,
      router: hoodRouter,
      amountAtoms: plan.amountAtoms,
      ...(plan.requestedWithdrawalAtoms
        ? {
            requestedWithdrawalAtoms: plan.requestedWithdrawalAtoms,
            ...(plan.withdrawAllShares ? { withdrawAllShares: true as const } : {}),
          }
        : {}),
      ...(plan.withdrawalRequestId ? { withdrawalRequestId: plan.withdrawalRequestId } : {}),
      ...(plan.withdrawalOperationId
        ? {
            withdrawalOperationId: plan.withdrawalOperationId,
            returnBudgetAtoms: plan.returnBudgetAtoms,
          }
        : {}),
      nonce: op.nonce!,
      deadline: plan.deadline,
      maximumTokenFeeAtoms: plan.maximumTokenFeeAtoms,
      budgetAtoms: plan.budgetAtoms,
      withdrawalReserveAtoms: plan.withdrawalReserveAtoms,
      slippageBps: plan.kind === "hoodDeposit" ? 10 : 0,
      ...(route
        ? {
            recipient: route.recipient,
            quoteId: route.quoteId,
            confidentialAccount: route.confidentialAccount,
            refundOwner: route.refundOwner,
          }
        : {}),
    },
    userOperation: op,
  };
}
