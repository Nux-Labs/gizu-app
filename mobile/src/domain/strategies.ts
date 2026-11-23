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

const byValue = (a: { valueAtoms: bigint }, b: { valueAtoms: bigint }) =>
  b.valueAtoms > a.valueAtoms ? 1 : b.valueAtoms < a.valueAtoms ? -1 : 0;

/** Held tokens on the stock chains, other than cash and vault shares. */
function stockRows(snapshot: MainnetPortfolioSnapshot): OwnedPortfolioAsset[] {
  return canonicalRows(snapshot.ownedAssets ?? []).filter((row) => {
    if (row.chainId !== 8453 && row.chainId !== 4663) return false;
    if (!/^0x[0-9a-fA-F]{40}$/.test(row.token)) return false;
    const key = `${row.chainId}:${row.token.toLowerCase()}`;
    return !stablecoins.has(key) && !vaultTokens.has(key);
  });
}

export type PortfolioHoldings = {
  /** Supported stocks, Earn vault positions and one USDC cash line, largest value first. */
  lines: BasketLine[];
  /** Priced stocks outside the strategy universe. */
  unsupported: { label: string; valueAtoms: bigint }[];
  /** Held stocks without a market value, so their share of the portfolio is unknown. */
  unpriced: string[];
  /** A stock row whose balance native has not finished reading. */
  incomplete: boolean;
};

/**
 * The portfolio as strategies see it: supported Base and Robinhood stocks, Earn vault positions
 * and all dollar stablecoins as one Base USDC cash line. Amounts never leave the phone.
 */
export function portfolioHoldings(snapshot: MainnetPortfolioSnapshot): PortfolioHoldings {
  const lines: BasketLine[] = [];
  const unsupported: PortfolioHoldings["unsupported"] = [];
  const unpriced: string[] = [];
  let incomplete = false;
  for (const row of stockRows(snapshot)) {
    if (!row.complete) {
      incomplete = true;
      continue;
    }
    if (BigInt(row.balanceAtoms ?? row.observedAtoms) <= 0n) continue;
    const value = portfolioAssetValue(row);
    if (value === null) {
      unpriced.push(row.symbol);
      continue;
    }
    if (BigInt(value) <= 0n) continue;
    const symbol = universeSymbol(row.chainId, row.token);
    if (symbol === null) {
      unsupported.push({ label: row.symbol, valueAtoms: BigInt(value) });
      continue;
    }
    lines.push({
      chainId: row.chainId,
      kind: 0,
      address: row.token,
      label: symbol,
      valueAtoms: BigInt(value),
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
  return { lines: lines.sort(byValue), unsupported, unpriced, incomplete };
}

export type PortfolioBasket = {
  /** The assets that get a weight, largest value first; `weights` follows the same order. */
  lines: BasketLine[];
  weights: number[];
  /**
   * Why this basket cannot stand for the portfolio yet; publishing waits until it is null. A
   * stock without a price, or unsupported stocks worth half a step or more, would change weights.
   */
  blocked:
    | { reason: "incomplete" }
    | { reason: "unpriced"; labels: string[] }
    | { reason: "unsupported"; labels: string[] }
    | null;
  /** Holdings that round below 5% or fall past the ten-asset limit, and their exact share. */
  leftOut: { labels: string[]; bps: number };
};

/**
 * The basket a strategy seals: the portfolio's own weights, rounded to the registry's 5% steps.
 * It is derived, never edited, so a sealed basket is the position its owner held when sealing.
 */
export function portfolioBasket(snapshot: MainnetPortfolioSnapshot): PortfolioBasket {
  const holdings = portfolioHoldings(snapshot);
  const extra = holdings.unsupported.reduce((sum, stock) => sum + stock.valueAtoms, 0n);
  const total = holdings.lines.reduce((sum, line) => sum + line.valueAtoms, 0n) + extra;
  const share = (value: bigint) => (total === 0n ? 0 : Number((value * 10_000n) / total));

  // Weights over every line first, so a holding that rounds to 0% is left out, not inflated.
  const all = suggestedWeights(holdings.lines);
  let lines = holdings.lines.filter((_, i) => all[i]! > 0).slice(0, STRATEGY_MAX_ASSETS);
  let weights = suggestedWeights(lines);
  // Past the ten-asset limit the kept lines share 100%; one could round to 0% again.
  lines = lines.filter((_, i) => weights[i]! > 0);
  weights = weights.filter((weight) => weight > 0);

  const kept = new Set(lines);
  const dropped = holdings.lines.filter((line) => !kept.has(line));
  // Together under half a step, unsupported stocks could not move a 5% weight; otherwise they block.
  const minor = share(extra) * 2 < STRATEGY_STEP_BPS;
  const small = minor ? holdings.unsupported : [];
  const leftOut = {
    labels: [...dropped, ...small].sort(byValue).map((line) => line.label),
    bps: share(
      dropped.reduce((sum, line) => sum + line.valueAtoms, 0n) +
        small.reduce((sum, stock) => sum + stock.valueAtoms, 0n),
    ),
  };

  let blocked: PortfolioBasket["blocked"] = null;
  if (snapshot.balanceComplete === false || holdings.incomplete) blocked = { reason: "incomplete" };
  else if (holdings.unpriced.length > 0)
    blocked = { reason: "unpriced", labels: holdings.unpriced };
  else if (!minor)
    blocked = {
      reason: "unsupported",
      labels: [...holdings.unsupported].sort(byValue).map((stock) => stock.label),
    };
  return { lines, weights, blocked, leftOut };
}

/**
 * Token amounts behind a strategy's basket: stock balances, vault shares and dollar cash. Prices
 * move weights on their own; amounts change only when the owner trades, deposits or withdraws.
 */
export function holdingAmounts(snapshot: MainnetPortfolioSnapshot): Record<string, string> {
  const amounts: Record<string, string> = {};
  for (const row of stockRows(snapshot))
    if (row.complete && BigInt(row.balanceAtoms ?? row.observedAtoms) > 0n)
      amounts[`${row.chainId}:0:${row.token.toLowerCase()}`] =
        row.balanceAtoms ?? row.observedAtoms;
  for (const position of canonicalRows(snapshot.positions ?? [])) {
    const profileId = vaultPositionProfile(position);
    if (!profileId || !position.shareAtoms || BigInt(position.shareAtoms) <= 0n) continue;
    const profile = earnProfiles[profileId];
    amounts[`${profile.chainId}:1:${profile.vault.toLowerCase()}`] = position.shareAtoms;
  }
  const cash = portfolioHoldings(snapshot).lines.find((line) => line.label === "USDC");
  if (cash) amounts.cash = cash.valueAtoms.toString();
  return amounts;
}

/** Amounts within this share of each other count as unchanged, so dust and rounding don't nag. */
const AMOUNT_TOLERANCE_BPS = 50n;

/** The portfolio holds different assets or amounts than when the basket was sealed. */
export function holdingsChanged(
  sealed: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(sealed), ...Object.keys(current)]);
  for (const key of keys) {
    const before = BigInt(sealed[key] ?? "0");
    const after = BigInt(current[key] ?? "0");
    const larger = before > after ? before : after;
    const gap = before > after ? before - after : after - before;
    if (larger > 0n && gap * 10_000n > larger * AMOUNT_TOLERANCE_BPS) return true;
  }
  return false;
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
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return count(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return count(seconds / 3_600, "hour");
  return count(Math.round(seconds / 60), "minute");
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
  social: { likes: number; comments: number };
  /** The newest revealed basket; empty before the first reveal. */
  latestAssets: SealedAssetView[];
  /** 0 until the owner first changes the price. */
  priceVersion: number;
  /** When the next price change is allowed; null when it is allowed now. */
  priceChangeAllowedAt: string | null;
  /** The signed-in viewer likes this strategy. */
  liked: boolean;
};

export type SealedAssetView = {
  chainId: number;
  kind: 0 | 1;
  address: string;
  weightBps: number;
  assetId: string;
};

export type StrategyHistoryEntry = {
  seq: number;
  committedAt: string | null;
  revealedAt: string | null;
  commitTx: string | null;
  revealTx: string | null;
  assets: SealedAssetView[];
  periodReturnBps: number | null;
  likes: number;
  comments: number;
  liked: boolean;
};

export type StrategyPriceChange = {
  /** 0 is the price the strategy was published with. */
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  at: string;
};

export type StrategyDetail = StrategyCard & {
  history: StrategyHistoryEntry[];
  priceHistory: StrategyPriceChange[];
};

/** A comment on a strategy's profile (`seq` null) or on one revealed update. */
export type StrategyComment = {
  id: number;
  seq: number | null;
  parentId: number | null;
  body: string;
  createdAt: string;
  /** An automatic nickname, or the strategy's name when its owner wrote it. */
  authorName: string;
  owner: boolean;
  mine: boolean;
  replies: StrategyComment[];
};

export type FeedEvent =
  | { kind: "sealed"; strategyId: number; strategyName: string; seq: number; at: string }
  | {
      kind: "revealed";
      strategyId: number;
      strategyName: string;
      seq: number;
      at: string;
      assets: SealedAssetView[];
      previousAssets: SealedAssetView[] | null;
      periodReturnBps: number | null;
      likes: number;
      comments: number;
      liked: boolean;
    }
  | {
      kind: "price";
      strategyId: number;
      strategyName: string;
      version: number;
      at: string;
      monthlyPriceAtoms: string;
      signalPriceAtoms: string;
      previous: { monthlyPriceAtoms: string; signalPriceAtoms: string };
    };

export type Page<T> = { list: T[]; next: string | null };

/** A signed-in social session; the token is a bearer credential for likes and comments only. */
export type SocialSession = {
  token: string;
  expiresAt: string;
  name: string;
  /** The strategy this session speaks for as its owner. */
  ownerOf: number | null;
};

export type StrategyPriceRequest = {
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  deadline: number;
  signature: string;
};

/** Likes, comments, the feed and social sign-in; writes need a session token. */
export interface StrategySocialService {
  challenge(): Promise<{ nonce: string; issuedAt: number }>;
  createSession(request: {
    account: string;
    nonce: string;
    issuedAt: number;
    signature: string;
    ownerLink?: { strategyId: number; signature: string };
  }): Promise<SocialSession>;
  like(
    token: string,
    strategyId: number,
    seq: number | null,
  ): Promise<{ liked: boolean; count: number }>;
  unlike(
    token: string,
    strategyId: number,
    seq: number | null,
  ): Promise<{ liked: boolean; count: number }>;
  comments(
    strategyId: number,
    seq: number | null,
    cursor: string | null,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<Page<StrategyComment>>;
  postComment(
    token: string,
    strategyId: number,
    comment: { body: string; seq: number | null; parentId: number | null },
  ): Promise<StrategyComment>;
  deleteComment(token: string, id: number): Promise<void>;
  reportComment(token: string, id: number): Promise<void>;
  hideComment(token: string, id: number): Promise<void>;
  feed(
    strategyIds: readonly number[] | null,
    cursor: string | null,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<Page<FeedEvent>>;
}

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

/** A trial seat: the key reads the strategy's current basket until it expires. */
export type StrategySubscription = { subscriberKey: string; expiresAt: string };

/** The newest sealed basket, as a subscriber receives it. */
export type StrategySignal = {
  seq: number;
  commitment: string;
  committedAt: string | null;
  commitTx: string | null;
  assets: SealedAssetView[];
  salt: string;
};

export interface StrategyService {
  /** A social token fills `liked`; reads work without one. */
  list(
    signers?: readonly string[],
    signal?: AbortSignal,
    token?: string | null,
  ): Promise<StrategyCard[]>;
  detail(id: number, signal?: AbortSignal, token?: string | null): Promise<StrategyDetail>;
  create(request: StrategyCreateRequest): Promise<StrategyDetail>;
  commit(id: number, request: StrategyCommitRequest): Promise<StrategyCommitResult>;
  subscribe(id: number): Promise<StrategySubscription>;
  /** Null before the strategy seals its first basket. */
  signal(id: number, subscriberKey: string, abort?: AbortSignal): Promise<StrategySignal | null>;
  changePrice(id: number, request: StrategyPriceRequest): Promise<StrategyDetail>;
}

/** The verified return line on a strategy card. */
export function strategyReturnText(card: StrategyCard): string {
  const bps = card.performance.cumulativeReturnBps;
  if (bps === null) return "Return verified after the first reveal";
  const sign = bps > 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}% verified over ${card.performance.closedPeriods} periods`;
}

export function drawdownText(card: StrategyCard): string | null {
  const bps = card.performance.maxDrawdownBps;
  return bps === null ? null : `Worst drop ${(Math.abs(bps) / 100).toFixed(2)}%`;
}

/**
 * How many revealed updates changed the vault share. Vault moves are slow and costly to follow,
 * so followers see how often a strategy makes them.
 */
export function vaultChanges(history: StrategyDetail["history"]): number {
  const revealed = history
    .filter((entry) => entry.revealedAt !== null && entry.assets.length > 0)
    .sort((a, b) => a.seq - b.seq);
  let changes = 0;
  let previous: string | null = null;
  for (const entry of revealed) {
    const vaults = entry.assets
      .filter((asset) => asset.kind === 1)
      .map((asset) => `${asset.chainId}:${asset.address.toLowerCase()}:${asset.weightBps}`)
      .sort()
      .join(",");
    if (previous !== null && vaults !== previous) changes += 1;
    previous = vaults;
  }
  return changes;
}

/** A USDC price with cents, for example "$10.00" or "$0.50". */
export function formatPrice(atoms: string): string {
  const [whole, fraction = ""] = formatUsdc(atoms).split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}
