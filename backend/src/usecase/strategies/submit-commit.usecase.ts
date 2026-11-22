import type { Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import {
  basketCommitment,
  commitSigner,
  sealBasket,
  type StrategyAsset,
} from "../../domain/strategy.ts";
import { inStrategyUniverse } from "../../adapters/strategies/universe.ts";
import type {
  StrategyCommitStatus,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../ports/strategies.port.ts";
import type { StrategyRelay } from "./strategy-relay.usecase.ts";

export type SubmitCommitInput = {
  seq: number;
  /** The basket as the app asked the signer to seal it, in any order. */
  assets: StrategyAsset[];
  /** The signer's sorted result, which must match the basket above. */
  assetIds: Hex[];
  weightsBps: number[];
  salt: Hex;
  commitment: Hex;
  signature: Hex;
  deadline: number;
};

export type SubmitCommitResult = { seq: number; status: StrategyCommitStatus; commitTx: Hex | null };

/** Leaves room before the signature's deadline for the relay and its confirmation. */
const DEADLINE_MARGIN_SECONDS = 60;
const RELAY_MARGIN_SECONDS = 120;

export class SubmitCommitUseCase {
  constructor(
    private readonly store: StrategyStore,
    private readonly registry: StrategyRegistryGateway,
    private readonly relay: Pick<StrategyRelay, "relay">,
    private readonly jitterMaxSeconds = 0,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(strategyId: number, input: SubmitCommitInput, now = new Date()): Promise<SubmitCommitResult> {
    const strategy = await this.store.strategy(strategyId);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(strategyId));

    const basket = sealBasket(input.assets, inStrategyUniverse);
    if (
      basket.length !== input.assetIds.length ||
      basket.length !== input.weightsBps.length ||
      basket.some(
        (asset, i) =>
          asset.assetId.toLowerCase() !== input.assetIds[i]!.toLowerCase() ||
          asset.weightBps !== input.weightsBps[i],
      )
    )
      throw mismatch();
    const commitment = basketCommitment(BigInt(strategyId), BigInt(input.seq), basket, input.salt);
    if (commitment.toLowerCase() !== input.commitment.toLowerCase()) throw mismatch();
    const signer = await commitSigner({
      chainId: this.registry.chainId,
      registry: this.registry.address,
      strategyId: BigInt(strategyId),
      seq: BigInt(input.seq),
      commitment,
      deadline: input.deadline,
      signature: input.signature,
    });
    if (signer.toLowerCase() !== strategy.signer.toLowerCase())
      throw new DomainError("STRATEGY_SIGNATURE_INVALID", "The signature does not match the strategy key.");
    const remaining = input.deadline - Math.floor(now.getTime() / 1000);
    if (remaining <= DEADLINE_MARGIN_SECONDS)
      throw new DomainError("STRATEGY_SIGNATURE_EXPIRED", "The signature expires too soon to relay.");

    const existing = await this.store.commits([strategyId]);
    if (existing.some((c) => c.status === "pending" || c.status === "relaying"))
      throw new DomainError("STRATEGY_COMMIT_PENDING", "The previous update is still being sealed.");
    if ((await this.registry.strategy(strategyId)).nextSeq !== input.seq)
      throw new DomainError("STRATEGY_SEQ_STALE", "The update was signed for another sequence number.");

    // A random delay before relaying separates the owner's trade time from the commitment time.
    const window = Math.max(0, Math.min(this.jitterMaxSeconds, remaining - RELAY_MARGIN_SECONDS));
    const delaySeconds = Math.floor(this.random() * window);
    const relayAfter = new Date(now.getTime() + delaySeconds * 1000);
    const pending = {
      strategyId,
      seq: input.seq,
      commitment,
      basket,
      salt: input.salt,
      signature: input.signature,
      deadline: input.deadline,
      relayAfter,
    };
    if (!(await this.store.addPendingCommit(pending)))
      throw new DomainError("STRATEGY_SEQ_TAKEN", "This sequence number is already sealed.");
    if (delaySeconds > 0) return { seq: input.seq, status: "pending", commitTx: null };

    const status = await this.relay.relay(
      { ...pending, status: "pending", commitTx: null, committedAt: null, revealTx: null, revealedAt: null },
      now,
    );
    const saved = (await this.store.commits([strategyId])).find((c) => c.seq === input.seq);
    const final = saved?.status ?? status;
    // The registry refused it; the sequence number is free for a newly signed update.
    if (final === "failed")
      throw new DomainError("STRATEGY_COMMIT_REJECTED", "The registry did not accept this update.");
    return { seq: input.seq, status: final, commitTx: saved?.commitTx ?? null };
  }
}

function mismatch() {
  return new DomainError("STRATEGY_COMMIT_MISMATCH", "The sealed basket does not match the request.");
}
