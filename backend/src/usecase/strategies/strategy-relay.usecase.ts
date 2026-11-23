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
 * Moves commitments onto the registry and reveals them after their embargo. The chain is the
 * source of truth: every send is claimed first, and both a send and a rejection are reconciled
 * against the chain, so a commitment that landed is never left marked as failed.
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
      const reconciled = await this.reconcile(commit);
      if (reconciled) return reconciled;
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
        // A rejection may only mean an earlier attempt landed meanwhile (the signature binds the
        // sequence number); check the chain again before giving the sequence number up.
        const reconciled = await this.reconcile(commit).catch(() => null);
        if (reconciled) return reconciled;
        await this.store.markFailed(strategyId, seq);
        this.log({ code: "STRATEGY_COMMIT_REJECTED", strategyId, seq, reason: error.reason });
        return "failed";
      }
      await this.store.releaseRelay(strategyId, seq);
      this.log({ code: "STRATEGY_COMMIT_RETRY", strategyId, seq });
      return "pending";
    }
  }

  /**
   * When the chain already holds this sequence number, records the outcome from the chain:
   * committed when it holds this commitment, failed when another one took the slot.
   */
  private async reconcile(commit: StrategyCommitRecord): Promise<StrategyCommitStatus | null> {
    const { strategyId, seq } = commit;
    const onchain = await this.registry.strategy(strategyId);
    if (onchain.nextSeq <= seq) return null;
    const landed = await this.registry.commitAt(strategyId, seq);
    if (landed.commitment.toLowerCase() !== commit.commitment.toLowerCase()) {
      await this.store.markFailed(strategyId, seq);
      this.log({ code: "STRATEGY_COMMIT_SEQ_TAKEN", strategyId, seq });
      return "failed";
    }
    await this.landed(commit, commit.commitTx, landed.committedAt);
    return "committed";
  }

  /**
   * Reveals the commitment the registry expects next. That is normally `due`; when the chain is
   * behind it (an earlier commitment is still unrevealed there), the earlier one is revealed first,
   * provided its stored preimage matches what the chain holds.
   */
  async reveal(due: StrategyCommitRecord, now = new Date()): Promise<void> {
    const { strategyId } = due;
    try {
      const onchain = await this.registry.strategy(strategyId);
      if (onchain.nextRevealSeq > due.seq) {
        await this.store.markRevealed(strategyId, due.seq, null, now);
        return;
      }
      let target = due;
      if (onchain.nextRevealSeq < due.seq) {
        const expected = onchain.nextRevealSeq;
        const earlier = (await this.store.commits([strategyId])).find((c) => c.seq === expected);
        const landed = await this.registry.commitAt(strategyId, expected);
        if (!earlier || earlier.commitment.toLowerCase() !== landed.commitment.toLowerCase()) {
          this.log({ code: "STRATEGY_REVEAL_PREIMAGE_MISSING", strategyId, seq: expected });
          return;
        }
        if (earlier.status !== "committed")
          await this.store.markCommitted(strategyId, expected, earlier.commitTx, landed.committedAt);
        target = earlier;
      }
      const result = await this.registry.reveal({
        strategyId,
        basket: target.basket,
        salt: target.salt,
      });
      await this.store.markRevealed(strategyId, result.seq, result.tx, result.revealedAt);
    } catch (error) {
      this.log({
        code: "STRATEGY_REVEAL_FAILED",
        strategyId,
        seq: due.seq,
        ...(error instanceof StrategyRegistryRejection ? { reason: error.reason } : {}),
      });
    }
  }

  /** Records the commitment, prices its period edges and queues the subscribers' notification. */
  private async landed(commit: StrategyCommitRecord, tx: StrategyCommitRecord["commitTx"], at: Date) {
    const { strategyId, seq } = commit;
    await this.store.markCommitted(strategyId, seq, tx, at);
    try {
      // Prices carry the time they were read, which is later than `at` after a reconciliation.
      const startPrices = await this.prices.prices(commit.basket);
      await this.store.saveSnapshot({ strategyId, seq, edge: "start", prices: startPrices, takenAt: new Date() });
      const previous = (await this.store.commits([strategyId])).find(
        (c) => c.seq === seq - 1 && (c.status === "committed" || c.status === "revealed"),
      );
      if (previous) {
        const endPrices = await this.prices.prices(previous.basket);
        await this.store.saveSnapshot({
          strategyId,
          seq: previous.seq,
          edge: "end",
          prices: endPrices,
          takenAt: new Date(),
        });
      }
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
