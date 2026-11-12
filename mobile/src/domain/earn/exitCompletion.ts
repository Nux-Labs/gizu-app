import { investmentDestination } from "@/domain/earn/distribution";
import { earnProfiles, type EarnIntent } from "./types";
import { earnAtoms, earnObject } from "./vaultExecution";
import { assertFresh, conservativeResidual } from "./policy";
import { hoodWrappedNative } from "./robinhoodExecution";
import type { LiquidityOperation } from "./ethereumLiquidity";
import type { SponsoredOperation } from "./sourceFunding";
import { parseMinimumReturn } from "./minimumReturn";
import type { EarnWithdrawalOperation } from "./withdrawal";
export type ExitSnapshot = {
  owner: string;
  profileId: EarnIntent["profileId"];
  balances: { tokenAtoms: string; nativeWei: string; wrappedWei: string; shares: string };
  residualUsdcAtoms: string;
  publicResidualReady: boolean;
  optimalResidual: boolean;
  expiresAtMs: number;
  observedAtMs: number;
  priceObservedAtMs: number;
  priceMaxAgeMs: 300000;
  priceUpdatedAt: { token: string; usdc: string; eth: string | null };
  snapshotHash: string;
};
export type ExitCompletion = {
  snapshot: ExitSnapshot;
  creditedReturnOperationIds: string[];
  creditedReturns?: { operationId: string; revision: number }[];
  /** Revisions of the parsed native journal checked here; presentation history only. */
  journalRevision?: string;
  complete: boolean;
};
export interface EarnExitCompletionService {
  check(intent: EarnIntent, signal: AbortSignal): Promise<ExitCompletion>;
}

/** Valid journal activity that still needs settlement, distinct from a failed read. */
export class InvestmentExitPendingError extends Error {}

export function exitActivityRevision(
  rows: readonly { operationId: string; revision: number; status: string; blocked: boolean }[],
): string {
  const revisions: [string, number, string, boolean][] = rows.map((row) => [
    row.operationId,
    row.revision,
    row.status,
    row.blocked,
  ]);
  revisions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(revisions);
}

export function exitHistoryRevision(
  journalRevision: string | undefined,
  payouts: readonly EarnWithdrawalOperation[],
): string | null {
  return journalRevision &&
    payouts.every((row) => !row.blocked && ["paid", "cancelled"].includes(row.status))
    ? JSON.stringify([journalRevision, exitActivityRevision(payouts)])
    : null;
}

/** Presentation completion only; current private holdings are irrelevant to a saved return. */
export function isCompleteInvestmentExit(
  result: ExitCompletion | null,
  intent: EarnIntent,
  withdrawals: readonly EarnWithdrawalOperation[],
  now = Date.now(),
): boolean {
  return (
    result?.complete === true &&
    result.snapshot.expiresAtMs > now &&
    result.snapshot.profileId === intent.profileId &&
    result.snapshot.owner.toLowerCase() === investmentDestination(intent).address.toLowerCase() &&
    result.creditedReturnOperationIds.length > 0 &&
    withdrawals.every(
      (row) => !row.blocked && (row.status === "paid" || row.status === "cancelled"),
    )
  );
}
const hash = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
function same(v: unknown, w: string) {
  return typeof v === "string" && v.toLowerCase() === w.toLowerCase();
}
function timestamp(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw Error("Invalid exit timestamp.");
  return v;
}
export function parseExitSnapshot(raw: unknown, intent: EarnIntent, now: number): ExitSnapshot {
  const r = earnObject(raw),
    p = earnProfiles[intent.profileId],
    owner = investmentDestination(intent).address,
    wrapped =
      intent.profileId === "ethereum-usdc"
        ? "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        : hoodWrappedNative;
  if (
    r.profileId !== intent.profileId ||
    r.chainId !== p.chainId ||
    !same(r.owner, owner) ||
    !same(r.token, p.token) ||
    !same(r.vault, p.vault) ||
    !same(r.wrappedToken, wrapped) ||
    r.tokenDecimals !== 6 ||
    r.wrappedDecimals !== 18 ||
    typeof r.shareDecimals !== "number" ||
    !Number.isInteger(r.shareDecimals) ||
    r.shareDecimals < 0 ||
    r.shareDecimals > 36 ||
    r.priceMaxAgeMs !== 300000 ||
    r.readOnly !== true ||
    r.completionAttested !== false ||
    r.walletScope !== "investment-only-hold-wallet-excluded" ||
    !hash(r.snapshotHash)
  )
    throw Error("Investment-wallet exit binding changed.");
  const b = earnObject(r.balances),
    prices = earnObject(r.prices),
    ref = earnObject(r.reference),
    balances = {
      tokenAtoms: earnAtoms(b.tokenAtoms),
      nativeWei: earnAtoms(b.nativeWei),
      wrappedWei: earnAtoms(b.wrappedWei),
      shares: earnAtoms(b.shares),
    };
  if (BigInt(earnAtoms(ref.blockNumber)) === 0n) throw Error("Missing exit block reference.");
  if (!hash(ref.blockHash)) throw Error("Invalid canonical exit reference.");
  const observedAtMs = timestamp(r.observedAtMs),
    expiresAtMs = timestamp(r.expiresAtMs),
    priceAt = timestamp(prices.observedAtMs),
    blockAt = timestamp(ref.blockTimestampMs);
  for (const at of [observedAtMs, blockAt]) assertFresh({ timestampMs: at, nowMs: now });
  const priceTimestamp = (value: unknown) => {
    if (typeof value !== "string") throw Error("Missing provider price timestamp.");
    const at = timestamp(Date.parse(value));
    assertFresh({ timestampMs: at, nowMs: now, maxAgeMs: 300000 });
    return at;
  };
  const tokenAt = priceTimestamp(prices.tokenPriceUpdatedAt),
    usdcAt = priceTimestamp(prices.usdcPriceUpdatedAt);
  const needsEth = BigInt(balances.nativeWei) + BigInt(balances.wrappedWei) > 0n;
  const ethAt = needsEth ? priceTimestamp(prices.ethPriceUpdatedAt) : null;
  if (
    (!needsEth && prices.ethPriceUpdatedAt !== null) ||
    priceAt !== Math.min(tokenAt, usdcAt, ...(ethAt === null ? [] : [ethAt]))
  )
    throw Error("Provider price timestamp changed.");
  if (
    expiresAtMs <= now ||
    expiresAtMs !== Math.min(priceAt + 300000, blockAt + 60000, observedAtMs + 60000) ||
    observedAtMs < Math.max(priceAt, blockAt) - 5000
  )
    throw Error("Exit check expired.");
  const assets = [
    {
      atoms: BigInt(balances.tokenAtoms),
      decimals: 6,
      usdPrice18: BigInt(earnAtoms(prices.tokenUsd18)),
    },
  ];
  const native = BigInt(balances.nativeWei),
    weth = BigInt(balances.wrappedWei);
  if (native + weth > 0n) {
    const eth = BigInt(earnAtoms(prices.ethUsd18));
    assets.push(
      { atoms: native, decimals: 18, usdPrice18: eth },
      { atoms: weth, decimals: 18, usdPrice18: eth },
    );
  } else if (prices.ethUsd18 !== null) throw Error("Unexpected native price requirement.");
  const residual = conservativeResidual(assets, BigInt(earnAtoms(prices.usdcUsd18)), {
      timestampMs: priceAt,
      nowMs: now,
      maxAgeMs: 300000,
    }),
    ready = balances.shares === "0" && residual.accepted,
    optimal = balances.shares === "0" && residual.optimal;
  if (
    earnAtoms(r.residualUsdcAtoms) !== residual.usdcAtoms.toString() ||
    r.publicResidualReady !== ready ||
    r.optimalResidual !== optimal
  )
    throw Error("Exit dust calculation changed.");
  return {
    profileId: intent.profileId,
    owner,
    balances,
    residualUsdcAtoms: residual.usdcAtoms.toString(),
    publicResidualReady: ready,
    optimalResidual: optimal,
    expiresAtMs,
    observedAtMs,
    priceObservedAtMs: priceAt,
    priceMaxAgeMs: 300000,
    priceUpdatedAt: {
      token: prices.tokenPriceUpdatedAt as string,
      usdc: prices.usdcPriceUpdatedAt as string,
      eth: prices.ethPriceUpdatedAt as string | null,
    },
    snapshotHash: r.snapshotHash as string,
  };
}
/** Inputs are refreshed native-service results, never a private balance or backend public status. */
export function assertReturnCredits(
  rows: readonly (LiquidityOperation | SponsoredOperation)[],
  intent: EarnIntent,
): string[] {
  if (!Array.isArray(rows) || rows.length > 256 || intent.status !== "prepared")
    throw Error("Native exit reconciliation required.");
  const seen = new Set<string>(),
    returns: string[] = [];
  for (const row of rows) {
    if (
      !/^[-a-zA-Z0-9_]{1,128}$/.test(row.operationId) ||
      seen.has(row.operationId) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.walletId !== intent.walletId ||
      !same(row.from, investmentDestination(intent).address) ||
      row.chainId !== earnProfiles[intent.profileId].chainId ||
      typeof row.blocked !== "boolean"
    )
      throw Error("Saved native progress must be reconciled.");
    if (row.blocked)
      throw new InvestmentExitPendingError("Saved native progress must be reconciled.");
    seen.add(row.operationId);
    const minimumReturnReceipt = parseMinimumReturn({ ...row }, intent);
    const isReturn =
      intent.profileId === "ethereum-usdc"
        ? ["returnUsdc", "returnEth"].includes(row.kind)
        : row.kind === "hoodTokenReturn";
    const allowed =
      intent.profileId === "ethereum-usdc"
        ? ["fusionEthOrder", "fusionUsdcApproval", "returnUsdc", "returnEth"]
        : ["hoodDeposit", "hoodRedeemAll", "hoodTokenReturn"];
    if (!allowed.includes(row.kind)) throw Error("Exit journal changed.");
    if (row.status === "cancelled") {
      if (row.transactionHash) throw Error("Cancelled signed progress must be reconciled.");
      continue;
    }
    if (row.status === "reverted") {
      if (!hash(row.transactionHash)) throw Error("Missing canonical reverted receipt.");
      continue;
    }
    if (row.status === "nonceCancelled") {
      if (!("cancellationTransactionHash" in row) || !hash(row.cancellationTransactionHash))
        throw Error("Missing canonical cancellation receipt.");
      continue;
    }
    if (isReturn) {
      if (
        (row.status !== "credited" && !minimumReturnReceipt) ||
        !hash(row.transactionHash) ||
        (row.status === "credited" && BigInt(earnAtoms(row.creditedAtoms)) === 0n)
      )
        throw new InvestmentExitPendingError(
          "Every submitted return needs authenticated operation credit.",
        );
      returns.push(row.operationId);
    } else if (
      !["fusionFilled", "approvalFinalized", "invested", "withdrawn", "residualShares"].includes(
        row.status,
      )
    )
      throw new InvestmentExitPendingError("Unfinished native operation must be reconciled.");
  }
  if (returns.length === 0)
    throw new InvestmentExitPendingError("No authenticated investment return has been confirmed.");
  return returns;
}
