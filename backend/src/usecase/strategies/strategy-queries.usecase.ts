import { createHash, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import {
  STRATEGY_REVEAL_GRACE_SECONDS,
  periodGrowth,
  priceChangeAllowedAt,
  strategyPerformance,
  strategyPriceHistory,
  type SealedStrategyAsset,
  type StrategyPerformance,
  type StrategyPriceVersion,
} from "../../domain/strategy.ts";
import type { SocialCount, SocialStore, SocialTarget } from "../../ports/social.port.ts";
import type {
  StrategyCommitRecord,
  StrategyPriceChange,
  StrategyPriceSnapshot,
  StrategyRecord,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../ports/strategies.port.ts";
import { decodeCursor, encodeCursor, invalidCursor } from "../cursor.ts";

const TRIAL_DAYS = 30;

export type StrategyCard = {
  id: number;
  signer: Address;
  name: string;
  embargoSeconds: number;
  /** The current prices: the newest price change, or the creation terms before any. */
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
  /** Strategy-level likes and profile-wall comments. */
  social: { likes: number; comments: number };
  /** The newest revealed basket; [] before the first reveal. */
  latestAssets: SealedStrategyAsset[];
  priceVersion: number;
  /** Null when a price change is allowed now. */
  priceChangeAllowedAt: string | null;
  /** The caller liked the strategy; false without a session. */
  liked: boolean;
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
  likes: number;
  comments: number;
  liked: boolean;
};

export type PriceHistoryView = {
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  at: string;
};

export type StrategyDetail = StrategyCard & {
  history: RevealedCommitView[];
  priceHistory: PriceHistoryView[];
};

/** Feed events never carry the weights of a basket still under embargo. */
export type FeedEvent =
  | { kind: "sealed"; strategyId: number; strategyName: string; seq: number; at: string }
  | {
      kind: "revealed";
      strategyId: number;
      strategyName: string;
      seq: number;
      at: string;
      assets: SealedStrategyAsset[];
      previousAssets: SealedStrategyAsset[] | null;
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

export type FeedPage = { list: FeedEvent[]; next: string | null };

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

/** The prices that apply now to new subscriptions and agent signals. */
export function currentPrices(
  strategy: StrategyRecord,
  changes: readonly StrategyPriceChange[],
): StrategyPriceVersion {
  return strategyPriceHistory(strategy, changes.filter((c) => c.strategyId === strategy.id)).at(-1)!;
}

type FeedKey = [atMs: number, strategyId: number, kindRank: number, n: number];

/**
 * Public reads expose only revealed baskets. The current basket leaves through `signal` alone, to
 * a subscriber key or a paid agent request.
 */
export class StrategyQueries {
  constructor(
    private readonly store: StrategyStore,
    private readonly registry: Pick<StrategyRegistryGateway, "chainId" | "address">,
    private readonly social: Pick<SocialStore, "counts" | "likedTargets">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `viewer` is the signed-in social account, which fills the `liked` flags. */
  async list(signers?: readonly Address[], viewer?: Address | null): Promise<StrategyCard[]> {
    const strategies = await this.store.listStrategies(signers ? { signers } : undefined);
    return (await this.views(strategies, viewer ?? null)).map((view) => view.card);
  }

  async detail(id: number, viewer?: Address | null): Promise<StrategyDetail> {
    const strategy = await this.store.strategy(id);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(id));
    const [view] = await this.views([strategy], viewer ?? null);
    return { ...view!.card, history: view!.history, priceHistory: view!.priceHistory };
  }

  /**
   * Seals, reveals and price changes, newest first. Sealed events carry no basket: the weights stay
   * under embargo until the reveal.
   */
  async feed(
    query: { strategyIds?: readonly number[]; cursor?: string; limit: number },
    viewer?: Address | null,
  ): Promise<FeedPage> {
    let after: FeedKey | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (!Array.isArray(decoded) || decoded.length !== 4 || !decoded.every((n) => Number.isSafeInteger(n)))
        throw invalidCursor();
      after = decoded as FeedKey;
    }
    const strategies = query.strategyIds
      ? (await this.store.listStrategies()).filter((s) => query.strategyIds!.includes(s.id))
      : await this.store.listStrategies();
    const views = await this.views(strategies, viewer ?? null);
    const events: { key: FeedKey; event: FeedEvent }[] = [];
    for (const { strategy, onchain, history, priceHistory } of views) {
      const base = { strategyId: strategy.id, strategyName: strategy.metadata.name };
      for (const commit of onchain)
        if (commit.committedAt)
          events.push({
            key: [commit.committedAt.getTime(), strategy.id, 0, commit.seq],
            event: { kind: "sealed", ...base, seq: commit.seq, at: commit.committedAt.toISOString() },
          });
      history.forEach((update, i) => {
        if (!update.revealedAt) return;
        events.push({
          key: [Date.parse(update.revealedAt), strategy.id, 1, update.seq],
          event: {
            kind: "revealed",
            ...base,
            seq: update.seq,
            at: update.revealedAt,
            assets: update.assets,
            previousAssets: i > 0 ? history[i - 1]!.assets : null,
            periodReturnBps: update.periodReturnBps,
            likes: update.likes,
            comments: update.comments,
            liked: update.liked,
          },
        });
      });
      priceHistory.forEach((price, i) => {
        if (i === 0) return;
        const previous = priceHistory[i - 1]!;
        events.push({
          key: [Date.parse(price.at), strategy.id, 2, price.version],
          event: {
            kind: "price",
            ...base,
            version: price.version,
            at: price.at,
            monthlyPriceAtoms: price.monthlyPriceAtoms,
            signalPriceAtoms: price.signalPriceAtoms,
            previous: { monthlyPriceAtoms: previous.monthlyPriceAtoms, signalPriceAtoms: previous.signalPriceAtoms },
          },
        });
      });
    }
    // Every strategy's events are built in memory: the registry holds few strategies, each with a
    // short history. Move this to a keyset query once that stops being true.
    const ordered = events
      .filter((e) => !after || compareKeys(e.key, after) < 0)
      .sort((a, b) => compareKeys(b.key, a.key));
    const page = ordered.slice(0, query.limit);
    return {
      list: page.map((e) => e.event),
      next: ordered.length > query.limit ? encodeCursor(page.at(-1)!.key) : null,
    };
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

  private async views(strategies: readonly StrategyRecord[], viewer: Address | null) {
    const ids = strategies.map((strategy) => strategy.id);
    const now = this.now();
    const [commits, snapshots, seats, earned, changes, counts, liked] = await Promise.all([
      this.store.commits(ids),
      this.store.snapshots(ids),
      this.store.seatsTaken(ids, now),
      this.store.earnedAtoms(ids),
      this.store.priceChanges(ids),
      this.social.counts(ids),
      viewer ? this.social.likedTargets(viewer, ids) : Promise.resolve([] as SocialTarget[]),
    ]);
    const countOf = (strategyId: number, seq: number | null): SocialCount | undefined =>
      counts.find((c) => c.strategyId === strategyId && c.seq === seq);
    const likedBy = (strategyId: number, seq: number | null) =>
      liked.some((t) => t.strategyId === strategyId && t.seq === seq);
    return strategies.map((strategy) => {
      const own = commits.filter((c) => c.strategyId === strategy.id);
      const onchain = own.filter(landed);
      const revealed = own.filter((c) => c.status === "revealed").sort((a, b) => a.seq - b.seq);
      const oldestOpen = onchain.filter((c) => c.status === "committed").sort((a, b) => a.seq - b.seq)[0];
      const periods = revealed.map((c) => period(c, snapshots));
      const lastCommit = onchain.map((c) => c.committedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      const prices = strategyPriceHistory(strategy, changes.filter((c) => c.strategyId === strategy.id));
      const current = prices.at(-1)!;
      const allowedAt = priceChangeAllowedAt(prices, now);
      const card: StrategyCard = {
        id: strategy.id,
        signer: strategy.signer,
        name: strategy.metadata.name,
        embargoSeconds: strategy.embargoSeconds,
        monthlyPriceAtoms: current.monthlyPriceAtoms,
        signalPriceAtoms: current.signalPriceAtoms,
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
        social: {
          likes: countOf(strategy.id, null)?.likes ?? 0,
          comments: countOf(strategy.id, null)?.comments ?? 0,
        },
        latestAssets: revealed.at(-1)?.basket ?? [],
        priceVersion: current.version,
        priceChangeAllowedAt: allowedAt?.toISOString() ?? null,
        liked: likedBy(strategy.id, null),
      };
      const history: RevealedCommitView[] = revealed.map((c, i) => {
        const growth = periodGrowth(periods[i]!);
        const count = countOf(strategy.id, c.seq);
        return {
          seq: c.seq,
          committedAt: c.committedAt?.toISOString() ?? null,
          revealedAt: c.revealedAt?.toISOString() ?? null,
          commitTx: c.commitTx,
          revealTx: c.revealTx,
          assets: c.basket,
          periodReturnBps: growth === null ? null : Math.round((growth - 1) * 10_000),
          likes: count?.likes ?? 0,
          comments: count?.comments ?? 0,
          liked: likedBy(strategy.id, c.seq),
        };
      });
      const priceHistory: PriceHistoryView[] = prices.map((p) => ({
        version: p.version,
        monthlyPriceAtoms: p.monthlyPriceAtoms,
        signalPriceAtoms: p.signalPriceAtoms,
        at: p.at.toISOString(),
      }));
      return { strategy, onchain, card, history, priceHistory };
    });
  }
}

function compareKeys(a: FeedKey, b: FeedKey): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
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
