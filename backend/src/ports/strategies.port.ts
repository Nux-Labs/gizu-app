import type { Address, Hex } from "viem";
import type {
  AssetPrices,
  SealedStrategyAsset,
  StrategyMetadata,
  StrategyPriceVersion,
  StrategyRegistryChainId,
} from "../domain/strategy.ts";

export type StrategyRecord = {
  id: number;
  signer: Address;
  embargoSeconds: number;
  metadata: StrategyMetadata;
  metadataHash: Hex;
  createTx: Hex | null;
  createdAt: Date;
};

/** `relaying` is claimed by one sender; a stale claim returns to the queue. */
export type StrategyCommitStatus = "pending" | "relaying" | "committed" | "revealed" | "failed";

export type StrategyCommitRecord = {
  strategyId: number;
  seq: number;
  commitment: Hex;
  /** Sorted by asset id, as sealed and later revealed. */
  basket: SealedStrategyAsset[];
  salt: Hex;
  signature: Hex;
  deadline: number;
  status: StrategyCommitStatus;
  relayAfter: Date;
  commitTx: Hex | null;
  committedAt: Date | null;
  revealTx: Hex | null;
  revealedAt: Date | null;
};

export type StrategyPriceEdge = "start" | "end";

export type StrategyPriceSnapshot = {
  strategyId: number;
  seq: number;
  edge: StrategyPriceEdge;
  prices: AssetPrices;
  takenAt: Date;
};

/** An accepted price change (version 1 and up); version 0 lives in the strategy's metadata. */
export type StrategyPriceChange = StrategyPriceVersion & {
  strategyId: number;
  signature: Hex;
  deadline: number;
};

export type StrategyCommitInsert = Omit<
  StrategyCommitRecord,
  "status" | "commitTx" | "committedAt" | "revealTx" | "revealedAt"
>;

export interface StrategyStore {
  /** Inserts once; an existing id or signer is left unchanged. */
  saveStrategy(strategy: StrategyRecord): Promise<void>;
  strategy(id: number): Promise<StrategyRecord | null>;
  strategyBySigner(signer: Address): Promise<StrategyRecord | null>;
  listStrategies(filter?: { signers?: readonly Address[] }): Promise<StrategyRecord[]>;
  commits(strategyIds: readonly number[]): Promise<StrategyCommitRecord[]>;
  /** False when that sequence number is already taken. */
  addPendingCommit(commit: StrategyCommitInsert): Promise<boolean>;
  /** Pending commitments due now, and claims older than the stale window. */
  dueRelays(now: Date, limit: number): Promise<StrategyCommitRecord[]>;
  /** Atomically claims a commitment for sending; false when another sender holds it. */
  claimRelay(strategyId: number, seq: number, now: Date): Promise<boolean>;
  /** Returns a claimed commitment to the queue after a transient failure. */
  releaseRelay(strategyId: number, seq: number): Promise<void>;
  /** `tx` is null when reconciliation found the commitment already on chain. */
  markCommitted(strategyId: number, seq: number, tx: Hex | null, committedAt: Date): Promise<void>;
  markFailed(strategyId: number, seq: number): Promise<void>;
  /** The oldest unrevealed commitment of each strategy whose embargo has passed. */
  dueReveals(now: Date, limit: number): Promise<StrategyCommitRecord[]>;
  markRevealed(strategyId: number, seq: number, tx: Hex | null, revealedAt: Date): Promise<void>;
  saveSnapshot(snapshot: StrategyPriceSnapshot): Promise<void>;
  snapshots(strategyIds: readonly number[]): Promise<StrategyPriceSnapshot[]>;
  /** Price changes of the given strategies, oldest version first. */
  priceChanges(strategyIds: readonly number[]): Promise<StrategyPriceChange[]>;
  /** False when that version is already taken. */
  addPriceChange(change: StrategyPriceChange): Promise<boolean>;
  /** Adds a trial seat unless every seat is taken; returns false when full. */
  addTrialSubscription(strategyId: number, keyHash: Hex, expiresAt: Date): Promise<boolean>;
  hasSubscription(strategyId: number, keyHash: Hex, now: Date): Promise<boolean>;
  seatsTaken(strategyIds: readonly number[], now: Date): Promise<Map<number, number>>;
  earnedAtoms(strategyIds: readonly number[]): Promise<Map<number, bigint>>;
  /** Books revenue once per settlement reference; false when that reference was already booked. */
  recordPayment(payment: {
    strategyId: number;
    kind: "x402";
    amountAtoms: string;
    reference: string;
  }): Promise<boolean>;
  /**
   * Registers a push token under a fresh random device id. Registering a known token replaces its
   * device and follows, so holding a token never reveals an existing device id; apps follow their
   * strategies again after registering.
   */
  registerPushDevice(token: string, platform: "android" | "ios"): Promise<string>;
  followWithDevice(deviceId: string, strategyId: number): Promise<boolean>;
  removePushDevice(deviceId: string): Promise<void>;
  /** Queues one neutral notification per device following the strategy. */
  queueStrategyPush(strategyId: number, seq: number): Promise<number>;
  /**
   * Queues the same neutral notification for a price change. It is queued under sequence number
   * `-version`, so it never collides with an update and collapses with them on delivery.
   */
  queuePricePush(strategyId: number, version: number): Promise<number>;
  /** Pending notifications, only the newest update per device and strategy. */
  pendingPushes(limit: number): Promise<PendingPush[]>;
  /** Settles a delivery and every older pending update it supersedes for that device and strategy. */
  finishPush(push: PendingPush, status: "sent" | "failed"): Promise<void>;
  /** Runs `work` only where no other instance holds the strategy worker lock. */
  withWorkerLock(work: () => Promise<void>): Promise<boolean>;
}

export type PendingPush = {
  deviceId: string;
  token: string;
  platform: "android" | "ios";
  strategyId: number;
  seq: number;
};

/** What a push provider did with one message. */
export type PushOutcome = "sent" | "unregistered" | "failed";

export interface PushSender {
  /** `ref` is opaque to the provider; the app maps it back to a strategy it follows. */
  send(message: { token: string; platform: "android" | "ios"; ref: string }): Promise<PushOutcome>;
}

export type OnchainStrategy = {
  signer: Address;
  embargoSeconds: number;
  nextSeq: number;
  nextRevealSeq: number;
  metadataHash: Hex;
};

export interface StrategyRegistryGateway {
  readonly chainId: StrategyRegistryChainId;
  readonly address: Address;
  strategyOf(signer: Address): Promise<number>;
  strategy(id: number): Promise<OnchainStrategy>;
  commitAt(id: number, seq: number): Promise<{ commitment: Hex; committedAt: Date }>;
  create(input: {
    signer: Address;
    embargo: number;
    metadataHash: Hex;
    deadline: number;
    signature: Hex;
  }): Promise<{ id: number; tx: Hex }>;
  commit(input: {
    strategyId: number;
    commitment: Hex;
    deadline: number;
    signature: Hex;
  }): Promise<{ seq: number; tx: Hex; committedAt: Date }>;
  reveal(input: {
    strategyId: number;
    basket: readonly SealedStrategyAsset[];
    salt: Hex;
  }): Promise<{ seq: number; tx: Hex; revealedAt: Date }>;
}

export interface StrategyPriceSource {
  /** USD price per asset id; null for any asset that could not be priced. */
  prices(assets: readonly SealedStrategyAsset[]): Promise<AssetPrices>;
}

/** What a paid signal request must satisfy, ready for the 402 response. */
export type SignalPaymentRequired = {
  /** Base64 `PAYMENT-REQUIRED` header value. */
  header: string;
  body: unknown;
  /** Opaque to callers; passed back to `settle`. */
  requirements: unknown;
};

export type SignalPaymentSettled = {
  payer: string;
  transaction: string;
  amountAtoms: string;
  /** Base64 `PAYMENT-RESPONSE` header value. */
  responseHeader: string;
};

/** x402 payment for one signal: build the requirements, then verify and settle a payment. */
export interface SignalPaywall {
  required(input: {
    priceAtoms: string;
    resourceUrl: string;
    description: string;
    error?: string;
  }): Promise<SignalPaymentRequired>;
  /** Throws `SignalPaymentRejected` when the payment is invalid or does not settle. */
  settle(input: {
    paymentHeader: string;
    required: SignalPaymentRequired;
  }): Promise<SignalPaymentSettled>;
}

export class SignalPaymentRejected extends Error {
  constructor(readonly reason: string) {
    super(`The payment was not accepted (${reason}).`);
    this.name = "SignalPaymentRejected";
  }
}
