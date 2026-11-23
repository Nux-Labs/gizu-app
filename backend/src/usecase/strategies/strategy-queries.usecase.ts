import { createHash, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import {
  STRATEGY_REVEAL_GRACE_SECONDS,
  periodGrowth,
  strategyPerformance,
  type SealedStrategyAsset,
  type StrategyPerformance,
} from "../../domain/strategy.ts";
import type {
  StrategyCommitRecord,
  StrategyPriceSnapshot,
  StrategyRecord,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../ports/strategies.port.ts";

const TRIAL_DAYS = 30;

export type StrategyCard = {
  id: number;
  signer: Address;
  name: string;
  embargoSeconds: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  seats: number;
  seatsTaken: number;
  commits: number;
  revealed: number;
  broken: boolean;
  lastCommitAt: string | null;
  performance: StrategyPerformance;
  earnedAtoms: string;
  createdAt: string;
  registry: { chainId: number; address: Address };
};

export type RevealedCommitView = {
  seq: number;
  committedAt: string | null;
  revealedAt: string | null;
  commitTx: Hex | null;
  revealTx: Hex | null;
  assets: SealedStrategyAsset[];
  /** Null while the period is open or a price was missing. */
  periodReturnBps: number | null;
};

export type StrategySignal = {
  strategyId: number;
  registry: { chainId: number; address: Address };
  signal: {
    seq: number;
    commitment: Hex;
    committedAt: string | null;
    commitTx: Hex | null;
    assets: SealedStrategyAsset[];
    /**
     * Lets an entitled buyer recompute the commitment and check it against the registry. It
     * reveals nothing beyond the weights the buyer already receives.
     */
    salt: Hex;
  } | null;
};

export function paymentRequired() {
  return new InfrastructureError(402, "PAYMENT_REQUIRED", "A subscription or payment is required.");
}

export function subscriberKeyHash(key: string): Hex {
  return `0x${createHash("sha256").update(key.toLowerCase()).digest("hex")}`;
}

/**
 * Public reads expose only revealed baskets. The current basket leaves through `signal` alone, to
 * a subscriber key or (later) a paid agent request.
 */
export class StrategyQueries {
  constructor(
    private readonly store: StrategyStore,
    private readonly registry: Pick<StrategyRegistryGateway, "chainId" | "address">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(signers?: readonly Address[]): Promise<StrategyCard[]> {
    const strategies = await this.store.listStrategies(signers ? { signers } : undefined);
    return (await this.views(strategies)).map((view) => view.card);
  }

  async detail(id: number): Promise<StrategyCard & { history: RevealedCommitView[] }> {
    const strategy = await this.store.strategy(id);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(id));
    const [view] = await this.views([strategy]);
    return { ...view!.card, history: view!.history };
  }

  async subscribe(id: number): Promise<{ subscriberKey: Hex; expiresAt: string }> {
    if (!(await this.store.strategy(id))) throw new NotFoundError({ name: "Strategy" }, String(id));
    const subscriberKey: Hex = `0x${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(this.now().getTime() + TRIAL_DAYS * 86_400_000);
    if (!(await this.store.addTrialSubscription(id, subscriberKeyHash(subscriberKey), expiresAt)))
      throw new DomainError("STRATEGY_FULL", "Every seat of this strategy is taken.");
    return { subscriberKey, expiresAt: expiresAt.toISOString() };
  }

  async signal(id: number, subscriberKey: string | undefined): Promise<StrategySignal> {
    if (!(await this.store.strategy(id))) throw new NotFoundError({ name: "Strategy" }, String(id));
    if (!subscriberKey || !/^0x[0-9a-fA-F]{64}$/.test(subscriberKey)) throw paymentRequired();
    if (!(await this.store.hasSubscription(id, subscriberKeyHash(subscriberKey), this.now())))
      throw paymentRequired();
    return this.latestSignal(id);
  }

  /** The newest commitment on chain, for a caller already entitled to it. */
  async latestSignal(id: number): Promise<StrategySignal> {
    const latest = (await this.store.commits([id]))
      .filter(landed)
      .sort((a, b) => b.seq - a.seq)[0];
    return {
      strategyId: id,
      registry: { chainId: this.registry.chainId, address: this.registry.address },
      signal: latest
        ? {
            seq: latest.seq,
            commitment: latest.commitment,
            committedAt: latest.committedAt?.toISOString() ?? null,
            commitTx: latest.commitTx,
            assets: latest.basket,
            salt: latest.salt,
          }
        : null,
    };
  }

  private async views(strategies: readonly StrategyRecord[]) {
    const ids = strategies.map((strategy) => strategy.id);
    const now = this.now();
    const [commits, snapshots, seats, earned] = await Promise.all([
      this.store.commits(ids),
      this.store.snapshots(ids),
      this.store.seatsTaken(ids, now),
      this.store.earnedAtoms(ids),
    ]);
    return strategies.map((strategy) => {
      const own = commits.filter((c) => c.strategyId === strategy.id);
      const onchain = own.filter(landed);
      const revealed = own.filter((c) => c.status === "revealed").sort((a, b) => a.seq - b.seq);
      const oldestOpen = onchain.filter((c) => c.status === "committed").sort((a, b) => a.seq - b.seq)[0];
      const periods = revealed.map((c) => period(c, snapshots));
      const lastCommit = onchain.map((c) => c.committedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      const card: StrategyCard = {
        id: strategy.id,
        signer: strategy.signer,
        name: strategy.metadata.name,
        embargoSeconds: strategy.embargoSeconds,
        monthlyPriceAtoms: strategy.metadata.monthlyPriceAtoms,
        signalPriceAtoms: strategy.metadata.signalPriceAtoms,
        seats: strategy.metadata.seats,
        seatsTaken: seats.get(strategy.id) ?? 0,
        commits: onchain.length,
        revealed: revealed.length,
        broken:
          !!oldestOpen?.committedAt &&
          oldestOpen.committedAt.getTime() +
            (strategy.embargoSeconds + STRATEGY_REVEAL_GRACE_SECONDS) * 1000 <
            now.getTime(),
        lastCommitAt: lastCommit?.toISOString() ?? null,
        performance: strategyPerformance(periods),
        earnedAtoms: (earned.get(strategy.id) ?? 0n).toString(),
        createdAt: strategy.createdAt.toISOString(),
        registry: { chainId: this.registry.chainId, address: this.registry.address },
      };
      const history: RevealedCommitView[] = revealed.map((c, i) => {
        const growth = periodGrowth(periods[i]!);
        return {
          seq: c.seq,
          committedAt: c.committedAt?.toISOString() ?? null,
          revealedAt: c.revealedAt?.toISOString() ?? null,
          commitTx: c.commitTx,
          revealTx: c.revealTx,
          assets: c.basket,
          periodReturnBps: growth === null ? null : Math.round((growth - 1) * 10_000),
        };
      });
      return { card, history };
    });
  }
}

function landed(commit: StrategyCommitRecord) {
  return commit.status === "committed" || commit.status === "revealed";
}

function period(commit: StrategyCommitRecord, snapshots: readonly StrategyPriceSnapshot[]) {
  const edge = (edge: "start" | "end") =>
    snapshots.find((s) => s.strategyId === commit.strategyId && s.seq === commit.seq && s.edge === edge)?.prices;
  const end = edge("end");
  return {
    basket: commit.basket,
    start: edge("start") ?? {},
    ...(end ? { end } : {}),
  };
}
