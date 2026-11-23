import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { DomainError } from "./errors/domain-error.ts";

/**
 * Sealed Strategies rules shared with contracts/src/StrategyRegistry.sol and the native signer
 * (mobile/modules/gizu-stored-signer/core/src/strategy.rs). shared/strategy-commit-vectors.json
 * pins the hashes all three compute.
 */
export const STRATEGY_TOTAL_BPS = 10_000;
export const STRATEGY_WEIGHT_STEP_BPS = 500;
export const STRATEGY_MAX_ASSETS = 10;
export const STRATEGY_MAX_EMBARGO_SECONDS = 30 * 86_400;
export const STRATEGY_REVEAL_GRACE_SECONDS = 86_400;
export const STRATEGY_REGISTRY_CHAIN_IDS = [8453, 84532] as const;
export type StrategyRegistryChainId = (typeof STRATEGY_REGISTRY_CHAIN_IDS)[number];

/** 0 is a token, 1 an Earn vault. */
export type StrategyAssetKind = 0 | 1;
export type StrategyAssetRef = { chainId: number; kind: StrategyAssetKind; address: Address };
export type StrategyAsset = StrategyAssetRef & { weightBps: number };
export type SealedStrategyAsset = StrategyAsset & { assetId: Hex };

export type StrategyMetadata = {
  name: string;
  /** USDC base units (6 decimals) as integer strings. */
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  seats: number;
};

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export class StrategyRuleError extends DomainError {
  constructor(message: string) {
    super("STRATEGY_INVALID", message);
  }
}

export function assetIdOf(asset: StrategyAssetRef): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint8" }, { type: "address" }],
      [BigInt(asset.chainId), asset.kind, asset.address],
    ),
  );
}

/** Validates a basket and returns it sorted by asset id, the order the registry reveals. */
export function sealBasket(
  assets: readonly StrategyAsset[],
  inUniverse: (asset: StrategyAssetRef) => boolean,
): SealedStrategyAsset[] {
  if (assets.length === 0 || assets.length > STRATEGY_MAX_ASSETS)
    throw new StrategyRuleError("A strategy holds one to ten assets.");
  let total = 0;
  const sealed = assets.map((asset) => {
    const address = getAddress(asset.address);
    if (
      !Number.isInteger(asset.weightBps) ||
      asset.weightBps <= 0 ||
      asset.weightBps % STRATEGY_WEIGHT_STEP_BPS !== 0
    )
      throw new StrategyRuleError("Each weight is a positive multiple of 5%.");
    if (!inUniverse({ chainId: asset.chainId, kind: asset.kind, address }))
      throw new StrategyRuleError("An asset is outside the strategy universe.");
    total += asset.weightBps;
    const ref = { chainId: asset.chainId, kind: asset.kind, address };
    return { ...ref, weightBps: asset.weightBps, assetId: assetIdOf(ref) };
  });
  if (total !== STRATEGY_TOTAL_BPS) throw new StrategyRuleError("Weights must add up to 100%.");
  sealed.sort((a, b) => compareWords(a.assetId, b.assetId));
  for (let i = 1; i < sealed.length; i++)
    if (sealed[i]!.assetId === sealed[i - 1]!.assetId)
      throw new StrategyRuleError("An asset appears twice.");
  return sealed;
}

function compareWords(a: Hex, b: Hex): number {
  const x = hexToBigInt(a);
  const y = hexToBigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** keccak256(abi.encode(id, seq, keccak(assetIds), keccak(weights as words), salt)). */
export function basketCommitment(
  strategyId: bigint,
  seq: bigint,
  basket: readonly SealedStrategyAsset[],
  salt: Hex,
): Hex {
  const assetsHash = keccak256(concatHex(basket.map((asset) => asset.assetId)));
  const weightsHash = keccak256(
    encodeAbiParameters(
      basket.map(() => ({ type: "uint256" })),
      basket.map((asset) => BigInt(asset.weightBps)),
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [strategyId, seq, assetsHash, weightsHash, salt],
    ),
  );
}

/** Canonical JSON with a fixed key order; the mobile app hashes the same string. */
export function canonicalStrategyMetadata(metadata: StrategyMetadata): string {
  return JSON.stringify({
    v: 1,
    name: metadata.name,
    monthlyPriceAtoms: metadata.monthlyPriceAtoms,
    signalPriceAtoms: metadata.signalPriceAtoms,
    seats: metadata.seats,
  });
}

export function strategyMetadataHash(metadata: StrategyMetadata): Hex {
  return keccak256(stringToBytes(canonicalStrategyMetadata(metadata)));
}

export function registryDomain(chainId: StrategyRegistryChainId, registry: Address) {
  return { name: "GizuStrategyRegistry", version: "1", chainId, verifyingContract: registry } as const;
}

export const createStrategyTypes = {
  CreateStrategy: [
    { name: "embargo", type: "uint32" },
    { name: "metadataHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const commitStrategyTypes = {
  Commit: [
    { name: "strategyId", type: "uint256" },
    { name: "seq", type: "uint64" },
    { name: "commitment", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** The registry accepts only 65-byte low-s signatures with v 27 or 28. */
export function assertRegistrySignature(signature: Hex): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new StrategyRuleError("The signature is malformed.");
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  if (s > SECP256K1_HALF_N || (v !== 27 && v !== 28))
    throw new StrategyRuleError("The signature is malformed.");
}

export async function createStrategySigner(input: {
  chainId: StrategyRegistryChainId;
  registry: Address;
  embargo: number;
  metadataHash: Hex;
  deadline: number;
  signature: Hex;
}): Promise<Address> {
  assertRegistrySignature(input.signature);
  return recoverTypedDataAddress({
    domain: registryDomain(input.chainId, input.registry),
    types: createStrategyTypes,
    primaryType: "CreateStrategy",
    message: {
      embargo: input.embargo,
      metadataHash: input.metadataHash,
      deadline: BigInt(input.deadline),
    },
    signature: input.signature,
  });
}

export async function commitSigner(input: {
  chainId: StrategyRegistryChainId;
  registry: Address;
  strategyId: bigint;
  seq: bigint;
  commitment: Hex;
  deadline: number;
  signature: Hex;
}): Promise<Address> {
  assertRegistrySignature(input.signature);
  return recoverTypedDataAddress({
    domain: registryDomain(input.chainId, input.registry),
    types: commitStrategyTypes,
    primaryType: "Commit",
    message: {
      strategyId: input.strategyId,
      seq: input.seq,
      commitment: input.commitment,
      deadline: BigInt(input.deadline),
    },
    signature: input.signature,
  });
}

/** A price change applies to new subscriptions and agent signals; seats and embargo never change. */
export const STRATEGY_PRICE_CHANGE_INTERVAL_SECONDS = 7 * 86_400;
/** Signatures relayed or verified by the backend expire within an hour. */
export const STRATEGY_SIGNATURE_MAX_AHEAD_SECONDS = 3_600;

/** Verified by the backend only; the registry never sees it. */
export const updatePriceTypes = {
  UpdatePrice: [
    { name: "strategyId", type: "uint256" },
    { name: "version", type: "uint64" },
    { name: "monthlyPriceAtoms", type: "uint64" },
    { name: "signalPriceAtoms", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export async function updatePriceSigner(input: {
  chainId: StrategyRegistryChainId;
  registry: Address;
  strategyId: bigint;
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  deadline: number;
  signature: Hex;
}): Promise<Address> {
  assertRegistrySignature(input.signature);
  return recoverTypedDataAddress({
    domain: registryDomain(input.chainId, input.registry),
    types: updatePriceTypes,
    primaryType: "UpdatePrice",
    message: {
      strategyId: input.strategyId,
      version: BigInt(input.version),
      monthlyPriceAtoms: BigInt(input.monthlyPriceAtoms),
      signalPriceAtoms: BigInt(input.signalPriceAtoms),
      deadline: BigInt(input.deadline),
    },
    signature: input.signature,
  });
}

/** Version 0 is the creation terms in the metadata; each accepted change adds one. */
export type StrategyPriceVersion = {
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  at: Date;
};

/** Every price version, oldest first, starting with the creation terms. */
export function strategyPriceHistory(
  strategy: { metadata: StrategyMetadata; createdAt: Date },
  changes: readonly StrategyPriceVersion[],
): StrategyPriceVersion[] {
  return [
    {
      version: 0,
      monthlyPriceAtoms: strategy.metadata.monthlyPriceAtoms,
      signalPriceAtoms: strategy.metadata.signalPriceAtoms,
      at: strategy.createdAt,
    },
    ...changes.filter((change) => change.version > 0).sort((a, b) => a.version - b.version),
  ];
}

/** When the next change is allowed, or null when it is allowed at `now`. */
export function priceChangeAllowedAt(history: readonly StrategyPriceVersion[], now: Date): Date | null {
  const last = history.at(-1);
  if (!last || last.version === 0) return null;
  const allowed = new Date(last.at.getTime() + STRATEGY_PRICE_CHANGE_INTERVAL_SECONDS * 1000);
  return allowed.getTime() > now.getTime() ? allowed : null;
}

/** USD prices keyed by asset id; null when a price was unavailable at that moment. */
export type AssetPrices = Readonly<Record<Hex, number | null>>;
export type StrategyPeriod = {
  basket: readonly { assetId: Hex; weightBps: number }[];
  start: AssetPrices;
  /** Prices at the next commitment; absent while the period is still open. */
  end?: AssetPrices;
};
export type StrategyPerformance = {
  /** Compounded return of closed periods, in basis points. */
  cumulativeReturnBps: number | null;
  /** Largest peak-to-trough fall of that compounded value, in basis points. */
  maxDrawdownBps: number | null;
  closedPeriods: number;
  /** False when any closed period lacked a price and was left out. */
  complete: boolean;
};

export function periodGrowth(period: StrategyPeriod): number | null {
  if (!period.end) return null;
  let growth = 0;
  for (const { assetId, weightBps } of period.basket) {
    const start = period.start[assetId];
    const end = period.end[assetId];
    if (start === null || start === undefined || end === null || end === undefined || start <= 0)
      return null;
    growth += (weightBps / STRATEGY_TOTAL_BPS) * (end / start);
  }
  return growth;
}

export function strategyPerformance(periods: readonly StrategyPeriod[]): StrategyPerformance {
  let value = 1;
  let peak = 1;
  let drawdown = 0;
  let closed = 0;
  let complete = true;
  for (const period of periods) {
    if (!period.end) continue;
    const growth = periodGrowth(period);
    if (growth === null) {
      complete = false;
      continue;
    }
    closed++;
    value *= growth;
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  if (closed === 0) return { cumulativeReturnBps: null, maxDrawdownBps: null, closedPeriods: 0, complete };
  return {
    cumulativeReturnBps: Math.round((value - 1) * STRATEGY_TOTAL_BPS),
    maxDrawdownBps: Math.round(drawdown * STRATEGY_TOTAL_BPS),
    closedPeriods: closed,
    complete,
  };
}
