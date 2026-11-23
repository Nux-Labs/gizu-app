import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { earnProfiles } from "@/domain/earn/types";
import { formatUsdc } from "@/domain/wallet/amounts";
import {
  canonicalRows,
  portfolioAssetValue,
  portfolioUsdcBalance,
  vaultNames,
  vaultPositionProfile,
} from "@/domain/wallet/portfolioValue";
import type {
  MainnetPortfolioSnapshot,
  OwnedPortfolioAsset,
  StrategyAssetInput,
  StrategyRegistryChainId,
} from "@/domain/wallet/storedSigner";
import { strategyStockTargets } from "@/domain/strategyUniverse";

/** Rules shared with the registry, the native signer and the API. */
export const STRATEGY_REGISTRY_CHAIN: StrategyRegistryChainId = 84532;
export const STRATEGY_TOTAL_BPS = 10_000;
export const STRATEGY_STEP_BPS = 500;
export const STRATEGY_MAX_ASSETS = 10;
/** Signatures must land within an hour; ten minutes leaves room for the relay. */
export const STRATEGY_SIGNATURE_SECONDS = 600;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const embargoOptions = [
  { label: "3 days", seconds: 3 * 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "14 days", seconds: 14 * 86_400 },
] as const;
/** Development builds may demo the whole reveal cycle in minutes. */
export const demoEmbargo = { label: "2 minutes", seconds: 120 } as const;

export type StrategyMetadata = {
  name: string;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  seats: number;
};

/** Canonical JSON with a fixed key order; the API hashes the same string. */
export function canonicalStrategyMetadata(metadata: StrategyMetadata): string {
  return JSON.stringify({
    v: 1,
    name: metadata.name,
    monthlyPriceAtoms: metadata.monthlyPriceAtoms,
    signalPriceAtoms: metadata.signalPriceAtoms,
    seats: metadata.seats,
  });
}

export function strategyMetadataHash(metadata: StrategyMetadata): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(canonicalStrategyMetadata(metadata))))}`;
}

/** Validation the API repeats; returns the first problem or null. */
export function metadataProblem(metadata: StrategyMetadata): string | null {
  if (!/^\S(.*\S)?$/.test(metadata.name) || metadata.name.length > 48)
    return "Name the strategy in up to 48 characters.";
  if (!/^(0|[1-9]\d{0,11})$/.test(metadata.monthlyPriceAtoms)) return "Enter a monthly price.";
  if (!/^(0|[1-9]\d{0,11})$/.test(metadata.signalPriceAtoms)) return "Enter a price per signal.";
  if (!Number.isInteger(metadata.seats) || metadata.seats < 1 || metadata.seats > 100)
    return "Seats must be between 1 and 100.";
  return null;
}

/** "10", "0.5" or "0,5" dollars to USDC base units; null when not a valid amount. */
export function usdcAtoms(dollars: string): string | null {
  // Comma-decimal keypads type "0,5".
  const match = /^(\d{1,12})(?:[.,](\d{0,6}))?$/.exec(dollars.trim());
  if (!match) return null;
  const atoms = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return atoms.toString();
}

export type BasketLine = {
  chainId: number;
  kind: 0 | 1;
  address: string;
  label: string;
  /** Display value in millionths of USD; used only to suggest weights. */
  valueAtoms: bigint;
};

/** Dollar stablecoins held on stock chains; they join the cash line instead of being assets. */
const stablecoins = new Set([
  ...Object.values(earnProfiles).map(
    (profile) => `${profile.chainId}:${profile.token.toLowerCase()}`,
  ),
  `8453:${BASE_USDC.toLowerCase()}`,
]);
const vaultTokens = new Set(
  Object.values(earnProfiles).map((profile) => `${profile.chainId}:${profile.vault.toLowerCase()}`),
);

function universeSymbol(chainId: number, token: string): string | null {
  if (chainId !== 4663 && chainId !== 8453) return null;
  const target = strategyStockTargets[chainId].find(
    (entry) => entry.address.toLowerCase() === token.toLowerCase(),
  );
  return target?.symbol ?? null;
}

type HeldStock = { row: OwnedPortfolioAsset; value: bigint; symbol: string | null };

/** Priced stock rows on stock chains, with their universe symbol when strategies support them. */
function heldStocks(snapshot: MainnetPortfolioSnapshot): HeldStock[] {
  return canonicalRows(snapshot.ownedAssets ?? []).flatMap((row) => {
    if (row.chainId !== 8453 && row.chainId !== 4663) return [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(row.token)) return [];
    const key = `${row.chainId}:${row.token.toLowerCase()}`;
    if (stablecoins.has(key) || vaultTokens.has(key)) return [];
    const value = portfolioAssetValue(row);
    if (value === null || BigInt(value) <= 0n) return [];
    return [{ row, value: BigInt(value), symbol: universeSymbol(row.chainId, row.token) }];
  });
}

/** Held stocks strategies cannot include, so the screen can say they were left out. */
export function unsupportedHoldings(snapshot: MainnetPortfolioSnapshot): string[] {
  return heldStocks(snapshot)
    .filter((stock) => stock.symbol === null)
    .map((stock) => stock.row.symbol);
}

/**
 * The basket a portfolio suggests: supported Base and Robinhood stocks, Earn vault positions and
 * all dollar stablecoins as one Base USDC cash line. Amounts never leave the phone; only the
 * rounded weights do.
 */
export function basketFromPortfolio(snapshot: MainnetPortfolioSnapshot): BasketLine[] {
  const lines: BasketLine[] = [];
  for (const { row, value, symbol } of heldStocks(snapshot)) {
    if (symbol === null) continue;
    lines.push({
      chainId: row.chainId,
      kind: 0,
      address: row.token,
      label: symbol,
      valueAtoms: value,
    });
  }
  for (const position of canonicalRows(snapshot.positions ?? [])) {
    const profileId = vaultPositionProfile(position);
    if (!profileId) continue;
    const value = portfolioAssetValue(position, true);
    if (value === null || BigInt(value) <= 0n) continue;
    const profile = earnProfiles[profileId];
    lines.push({
      chainId: profile.chainId,
      kind: 1,
      address: profile.vault,
      label: vaultNames[profileId],
      valueAtoms: BigInt(value),
    });
  }
  // Monad USDC (public and private) plus dollar stablecoins held on the stock chains.
  let cash = BigInt(portfolioUsdcBalance(snapshot)?.totalAtoms ?? "0");
  for (const row of canonicalRows(snapshot.ownedAssets ?? [])) {
    if (!stablecoins.has(`${row.chainId}:${row.token.toLowerCase()}`)) continue;
    const value = portfolioAssetValue(row);
    if (value !== null) cash += BigInt(value);
  }
  if (cash > 0n)
    lines.push({ chainId: 8453, kind: 0, address: BASE_USDC, label: "USDC", valueAtoms: cash });
  return lines
    .sort((a, b) => (b.valueAtoms > a.valueAtoms ? 1 : b.valueAtoms < a.valueAtoms ? -1 : 0))
    .slice(0, STRATEGY_MAX_ASSETS);
}

/** Rounds values to 5% steps summing to 100% by largest remainder; ties go to the larger value. */
export function suggestedWeights(lines: readonly BasketLine[]): number[] {
  const total = lines.reduce((sum, line) => sum + line.valueAtoms, 0n);
  if (total === 0n) return lines.map(() => 0);
  const steps = BigInt(STRATEGY_TOTAL_BPS / STRATEGY_STEP_BPS);
  const exact = lines.map((line) => line.valueAtoms * steps);
  const units = exact.map((value) => value / total);
  let left = Number(steps - units.reduce((sum, unit) => sum + unit, 0n));
  const order = exact
    .map((value, i) => ({ i, remainder: value % total }))
    .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left-- <= 0) break;
    units[i]! += 1n;
  }
  return units.map((unit) => Number(unit) * STRATEGY_STEP_BPS);
}

export function basketAssets(
  lines: readonly BasketLine[],
  weights: readonly number[],
): StrategyAssetInput[] {
  return lines.flatMap((line, i) =>
    weights[i]! > 0
      ? [{ chainId: line.chainId, kind: line.kind, address: line.address, weightBps: weights[i]! }]
      : [],
  );
}

/** The registry's basket rules; returns the first problem or null. */
export function basketProblem(weights: readonly number[]): string | null {
  const used = weights.filter((weight) => weight > 0);
  if (used.length === 0) return "Give at least one asset a weight.";
  if (used.length > STRATEGY_MAX_ASSETS) return "A strategy holds up to ten assets.";
  if (used.some((weight) => weight % STRATEGY_STEP_BPS !== 0)) return "Weights move in 5% steps.";
  const total = used.reduce((sum, weight) => sum + weight, 0);
  if (total !== STRATEGY_TOTAL_BPS) return `Weights add up to ${total / 100}%; make it 100%.`;
  return null;
}

export function formatWeight(weightBps: number): string {
  return `${weightBps / 100}%`;
}

export function formatEmbargo(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

export type StrategyPerformance = {
  /** Compounded return of revealed, closed periods, in basis points. */
  cumulativeReturnBps: number | null;
  maxDrawdownBps: number | null;
  closedPeriods: number;
  complete: boolean;
};

export type StrategyCard = {
  id: number;
  signer: string;
  name: string;
  embargoSeconds: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  seats: number;
  seatsTaken: number;
  /** Commitments on chain. */
  commits: number;
  revealed: number;
  broken: boolean;
  lastCommitAt: string | null;
  performance: StrategyPerformance;
  earnedAtoms: string;
  createdAt: string;
  registry: { chainId: number; address: string };
};

export type SealedAssetView = {
  chainId: number;
  kind: 0 | 1;
  address: string;
  weightBps: number;
  assetId: string;
};

export type StrategyDetail = StrategyCard & {
  history: {
    seq: number;
    committedAt: string | null;
    revealedAt: string | null;
    commitTx: string | null;
    revealTx: string | null;
    assets: SealedAssetView[];
    periodReturnBps: number | null;
  }[];
};

export type StrategyCreateRequest = {
  signer: string;
  embargo: number;
  metadata: StrategyMetadata;
  deadline: number;
  signature: string;
};

export type StrategyCommitRequest = {
  seq: number;
  assets: StrategyAssetInput[];
  assetIds: string[];
  weightsBps: number[];
  salt: string;
  commitment: string;
  signature: string;
  deadline: number;
};

export type StrategyCommitResult = {
  seq: number;
  status: "committed" | "pending" | "relaying";
  commitTx: string | null;
};

export interface StrategyService {
  list(signers?: readonly string[], signal?: AbortSignal): Promise<StrategyCard[]>;
  detail(id: number, signal?: AbortSignal): Promise<StrategyDetail>;
  create(request: StrategyCreateRequest): Promise<StrategyDetail>;
  commit(id: number, request: StrategyCommitRequest): Promise<StrategyCommitResult>;
}

/** A USDC price with cents, for example "$10.00" or "$0.50". */
export function formatPrice(atoms: string): string {
  const [whole, fraction = ""] = formatUsdc(atoms).split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}
