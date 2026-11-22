import { StrategyRegistryRejection } from "../../adapters/evm/strategy-registry.ts";
import type {
  StrategyCommitRecord,
  StrategyCommitStatus,
  StrategyPriceSource,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../ports/strategies.port.ts";

export type StrategyLog = (event: { code: string; strategyId?: number; seq?: number; reason?: string }) => void;

const BATCH = 10;

/**
 * Moves commitments onto the registry and reveals them after their embargo. Every send is claimed
 * first and reconciled against the chain, so a retry after a lost receipt never marks a landed
 * commitment as failed.
 */
export class StrategyRelay {
  constructor(
    private readonly store: StrategyStore,
    private readonly registry: StrategyRegistryGateway,
    private readonly prices: StrategyPriceSource,
    private readonly log: StrategyLog = () => {},
  ) {}

  /** One worker pass; another instance holding the lock makes this a no-op. */
  async runOnce(now = new Date()): Promise<void> {
    await this.store.withWorkerLock(async () => {
      for (const commit of await this.store.dueRelays(now, BATCH)) await this.relay(commit, now);
      for (const commit of await this.store.dueReveals(now, BATCH)) await this.reveal(commit, now);
    });
  }

  async relay(commit: StrategyCommitRecord, now = new Date()): Promise<StrategyCommitStatus> {
    const { strategyId, seq } = commit;
    if (!(await this.store.claimRelay(strategyId, seq, now))) return "relaying";
    try {
      const onchain = await this.registry.strategy(strategyId);
      if (onchain.nextSeq > seq) {
        // This sequence number is already on chain: a previous attempt landed, or it is taken.
        const landed = await this.registry.commitAt(strategyId, seq);
        if (landed.commitment.toLowerCase() !== commit.commitment.toLowerCase()) {
          await this.store.markFailed(strategyId, seq);
          this.log({ code: "STRATEGY_COMMIT_SEQ_TAKEN", strategyId, seq });
          return "failed";
        }
        await this.landed(commit, null, landed.committedAt);
        return "committed";
      }
      if (commit.deadline * 1000 <= now.getTime()) {
        await this.store.markFailed(strategyId, seq);
        this.log({ code: "STRATEGY_COMMIT_EXPIRED", strategyId, seq });
        return "failed";
      }
      const result = await this.registry.commit({
        strategyId,
        commitment: commit.commitment,
        deadline: commit.deadline,
        signature: commit.signature,
      });
      await this.landed(commit, result.tx, result.committedAt);
      return "committed";
    } catch (error) {
      if (error instanceof StrategyRegistryRejection) {
        await this.store.markFailed(strategyId, seq);
        this.log({ code: "STRATEGY_COMMIT_REJECTED", strategyId, seq, reason: error.reason });
        return "failed";
      }
      await this.store.releaseRelay(strategyId, seq);
      this.log({ code: "STRATEGY_COMMIT_RETRY", strategyId, seq });
      return "pending";
    }
  }

  async reveal(commit: StrategyCommitRecord, now = new Date()): Promise<void> {
    const { strategyId, seq } = commit;
    try {
      const onchain = await this.registry.strategy(strategyId);
      if (onchain.nextRevealSeq > seq) {
        await this.store.markRevealed(strategyId, seq, null, now);
        return;
      }
      const result = await this.registry.reveal({ strategyId, basket: commit.basket, salt: commit.salt });
      await this.store.markRevealed(strategyId, result.seq, result.tx, result.revealedAt);
    } catch (error) {
      this.log({
        code: "STRATEGY_REVEAL_FAILED",
        strategyId,
        seq,
        ...(error instanceof StrategyRegistryRejection ? { reason: error.reason } : {}),
      });
    }
  }

  /** Records the commitment, prices its period edges and queues the subscribers' notification. */
  private async landed(commit: StrategyCommitRecord, tx: StrategyCommitRecord["commitTx"], at: Date) {
    const { strategyId, seq } = commit;
    await this.store.markCommitted(strategyId, seq, tx, at);
    try {
      await this.store.saveSnapshot({
        strategyId,
        seq,
        edge: "start",
        prices: await this.prices.prices(commit.basket),
        takenAt: at,
      });
      const previous = (await this.store.commits([strategyId])).find(
        (c) => c.seq === seq - 1 && (c.status === "committed" || c.status === "revealed"),
      );
      if (previous)
        await this.store.saveSnapshot({
          strategyId,
          seq: previous.seq,
          edge: "end",
          prices: await this.prices.prices(previous.basket),
          takenAt: at,
        });
    } catch {
      this.log({ code: "STRATEGY_SNAPSHOT_FAILED", strategyId, seq });
    }
    try {
      await this.store.queueStrategyPush(strategyId, seq);
    } catch {
      this.log({ code: "STRATEGY_PUSH_QUEUE_FAILED", strategyId, seq });
    }
  }
}
