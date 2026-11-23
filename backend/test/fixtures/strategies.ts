import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { StrategyRegistryRejection } from "../../src/adapters/evm/strategy-registry.ts";
import {
  basketCommitment,
  commitStrategyTypes,
  createStrategyTypes,
  registryDomain,
  sealBasket,
  strategyMetadataHash,
  type SealedStrategyAsset,
  type StrategyAsset,
  type StrategyMetadata,
} from "../../src/domain/strategy.ts";
import { inStrategyUniverse } from "../../src/adapters/strategies/universe.ts";
import type {
  CommentInsert,
  CommentRecord,
  SocialCount,
  SocialSession,
  SocialStore,
  SocialTarget,
} from "../../src/ports/social.port.ts";
import type {
  OnchainStrategy,
  StrategyCommitInsert,
  StrategyCommitRecord,
  StrategyPriceChange,
  StrategyPriceSnapshot,
  StrategyRecord,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../src/ports/strategies.port.ts";
import { SocialSessions } from "../../src/usecase/social/social-sessions.usecase.ts";
import { StrategySocial } from "../../src/usecase/social/strategy-social.usecase.ts";
import { ChangePriceUseCase } from "../../src/usecase/strategies/change-price.usecase.ts";
import { CreateStrategyUseCase } from "../../src/usecase/strategies/create-strategy.usecase.ts";
import { StrategyQueries } from "../../src/usecase/strategies/strategy-queries.usecase.ts";
import { StrategyRelay } from "../../src/usecase/strategies/strategy-relay.usecase.ts";
import { SubmitCommitUseCase } from "../../src/usecase/strategies/submit-commit.usecase.ts";

/** In-memory fakes shared by the strategy, social and price tests; they mirror PgStrategies and PgSocial. */

export const { mnemonic } = JSON.parse(
  readFileSync(new URL("../../../shared/strategy-commit-vectors.json", import.meta.url), "utf8"),
) as { mnemonic: string };
export const REGISTRY: Address = "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7";
export const NOW = new Date("2026-11-23T12:00:00Z");
export const NOW_S = Math.floor(NOW.getTime() / 1000);
export const owner = mnemonicToAccount(mnemonic, { path: "m/44'/60'/146'/84532'/0" });
export const stranger = mnemonicToAccount(mnemonic, { path: "m/44'/60'/146'/84532'/1" });
export const metadata: StrategyMetadata = { name: "AI chips", monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000", seats: 2 };
export const basketInput: StrategyAsset[] = [
  { chainId: 8453, kind: 0, address: "0xb20000000000000000000078ee7ce2fE4908108C", weightBps: 6000 },
  { chainId: 8453, kind: 0, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weightBps: 3000 },
  { chainId: 4663, kind: 1, address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", weightBps: 1000 },
];
export const SALT: Hex = `0x${"07".repeat(32)}`;

export class MemoryStore implements StrategyStore {
  strategies: StrategyRecord[] = [];
  rows: StrategyCommitRecord[] = [];
  snaps: StrategyPriceSnapshot[] = [];
  subs: { strategyId: number; keyHash: Hex; expiresAt: Date }[] = [];
  pushes: { strategyId: number; seq: number }[] = [];
  async saveStrategy(s: StrategyRecord) {
    if (!this.strategies.some((x) => x.id === s.id || x.signer.toLowerCase() === s.signer.toLowerCase())) this.strategies.push(s);
  }
  async strategy(id: number) { return this.strategies.find((s) => s.id === id) ?? null; }
  async strategyBySigner(signer: Address) { return this.strategies.find((s) => s.signer.toLowerCase() === signer.toLowerCase()) ?? null; }
  async listStrategies(filter?: { signers?: readonly Address[] }) {
    const signers = filter?.signers?.map((s) => s.toLowerCase());
    return this.strategies.filter((s) => !signers || signers.includes(s.signer.toLowerCase()));
  }
  async commits(ids: readonly number[]) { return this.rows.filter((c) => ids.includes(c.strategyId)).map((c) => ({ ...c })); }
  async addPendingCommit(c: StrategyCommitInsert) {
    const existing = this.rows.findIndex((x) => x.strategyId === c.strategyId && x.seq === c.seq);
    if (existing >= 0 && this.rows[existing]!.status !== "failed") return false;
    const row: StrategyCommitRecord = { ...c, status: "pending", commitTx: null, committedAt: null, revealTx: null, revealedAt: null };
    if (existing >= 0) this.rows[existing] = row; else this.rows.push(row);
    return true;
  }
  private row(id: number, seq: number) { return this.rows.find((c) => c.strategyId === id && c.seq === seq)!; }
  async dueRelays(now: Date) { return this.rows.filter((c) => c.status === "pending" && c.relayAfter <= now); }
  async claimRelay(id: number, seq: number) {
    const row = this.row(id, seq);
    if (row.status !== "pending") return false;
    row.status = "relaying";
    return true;
  }
  async releaseRelay(id: number, seq: number) { const row = this.row(id, seq); if (row.status === "relaying") row.status = "pending"; }
  async markCommitted(id: number, seq: number, tx: Hex | null, at: Date) {
    const row = this.row(id, seq);
    // Mirrors PgStrategies: the chain may correct a row recorded as failed.
    if (row.status === "pending" || row.status === "relaying" || row.status === "failed")
      Object.assign(row, { status: "committed", commitTx: tx ?? row.commitTx, committedAt: at });
  }
  async markFailed(id: number, seq: number) {
    const row = this.row(id, seq);
    if (row.status === "pending" || row.status === "relaying") row.status = "failed";
  }
  async dueReveals(now: Date) {
    return this.strategies.flatMap((s) => {
      const open = this.rows.filter((c) => c.strategyId === s.id && c.status === "committed").sort((a, b) => a.seq - b.seq)[0];
      return open && open.committedAt!.getTime() + s.embargoSeconds * 1000 <= now.getTime() ? [open] : [];
    });
  }
  async markRevealed(id: number, seq: number, tx: Hex | null, at: Date) {
    const row = this.row(id, seq);
    if (row.status === "committed") Object.assign(row, { status: "revealed", revealTx: tx, revealedAt: at });
  }
  async saveSnapshot(s: StrategyPriceSnapshot) { this.snaps.push(s); }
  async snapshots(ids: readonly number[]) { return this.snaps.filter((s) => ids.includes(s.strategyId)); }
  async addTrialSubscription(strategyId: number, keyHash: Hex, expiresAt: Date) {
    const seats = (await this.strategy(strategyId))!.metadata.seats;
    if (this.subs.filter((s) => s.strategyId === strategyId).length >= seats) return false;
    this.subs.push({ strategyId, keyHash, expiresAt });
    return true;
  }
  async hasSubscription(strategyId: number, keyHash: Hex, now: Date) {
    return this.subs.some((s) => s.strategyId === strategyId && s.keyHash === keyHash && s.expiresAt > now);
  }
  async seatsTaken(ids: readonly number[]) {
    return new Map(ids.map((id) => [id, this.subs.filter((s) => s.strategyId === id).length]));
  }
  payments: { strategyId: number; amountAtoms: string; reference: string }[] = [];
  async earnedAtoms(ids: readonly number[]) {
    return new Map(ids.map((id) => [id, this.payments.filter((p) => p.strategyId === id).reduce((sum, p) => sum + BigInt(p.amountAtoms), 0n)]));
  }
  async recordPayment(payment: { strategyId: number; kind: "x402"; amountAtoms: string; reference: string }) {
    if (this.payments.some((p) => p.reference === payment.reference.toLowerCase())) return false;
    this.payments.push({ ...payment, reference: payment.reference.toLowerCase() });
    return true;
  }
  async registerPushDevice() { return "device"; }
  async followWithDevice() { return true; }
  async removePushDevice() {}
  async queueStrategyPush(strategyId: number, seq: number) { this.pushes.push({ strategyId, seq }); return 1; }
  async queuePricePush(strategyId: number, version: number) { return this.queueStrategyPush(strategyId, -version); }
  priceRows: StrategyPriceChange[] = [];
  async priceChanges(ids: readonly number[]) {
    return this.priceRows.filter((p) => ids.includes(p.strategyId)).sort((a, b) => a.strategyId - b.strategyId || a.version - b.version);
  }
  async addPriceChange(change: StrategyPriceChange) {
    if (this.priceRows.some((p) => p.strategyId === change.strategyId && p.version === change.version)) return false;
    this.priceRows.push(change);
    return true;
  }
  async withWorkerLock(work: () => Promise<void>) { await work(); return true; }
  async pendingPushes() { return []; }
  async finishPush() {}
}

export class FakeRegistry implements StrategyRegistryGateway {
  readonly chainId = 84532 as const;
  readonly address = REGISTRY;
  chain = new Map<number, OnchainStrategy & { commits: { commitment: Hex; committedAt: Date }[] }>();
  /** When set, the next commit lands but its receipt is lost. */
  loseNextReceipt = false;
  commitCalls = 0;
  async strategyOf(signer: Address) {
    for (const [id, s] of this.chain) if (s.signer.toLowerCase() === signer.toLowerCase()) return id;
    return 0;
  }
  async strategy(id: number) {
    const s = this.chain.get(id);
    if (!s) throw new StrategyRegistryRejection("UnknownStrategy");
    return { signer: s.signer, embargoSeconds: s.embargoSeconds, nextSeq: s.commits.length, nextRevealSeq: s.nextRevealSeq, metadataHash: s.metadataHash };
  }
  async commitAt(id: number, seq: number) { return this.chain.get(id)!.commits[seq]!; }
  async create(input: { signer: Address; embargo: number; metadataHash: Hex }) {
    const id = this.chain.size + 1;
    this.chain.set(id, { signer: input.signer, embargoSeconds: input.embargo, metadataHash: input.metadataHash, nextSeq: 0, nextRevealSeq: 0, commits: [] });
    return { id, tx: `0x${"c1".repeat(32)}` as Hex };
  }
  async commit(input: { strategyId: number; commitment: Hex }) {
    this.commitCalls++;
    const s = this.chain.get(input.strategyId)!;
    s.commits.push({ commitment: input.commitment, committedAt: NOW });
    if (this.loseNextReceipt) {
      this.loseNextReceipt = false;
      throw new Error("receipt timeout");
    }
    return { seq: s.commits.length - 1, tx: `0x${"c2".repeat(32)}` as Hex, committedAt: NOW };
  }
  async reveal(input: { strategyId: number }) {
    const s = this.chain.get(input.strategyId)!;
    return { seq: s.nextRevealSeq++, tx: `0x${"c3".repeat(32)}` as Hex, revealedAt: NOW };
  }
}

export const prices = { prices: async (assets: readonly SealedStrategyAsset[]) => Object.fromEntries(assets.map((a) => [a.assetId, 10])) };

export class MemorySocial implements SocialStore {
  challenges: { nonce: Hex; issuedAt: number; expiresAt: Date; used: boolean }[] = [];
  sessions = new Map<Hex, SocialSession>();
  likes: (SocialTarget & { account: Address })[] = [];
  rows: CommentRecord[] = [];
  reports: { commentId: number; account: Address; reason: string | null }[] = [];
  async addChallenge(nonce: Hex, issuedAt: number, expiresAt: Date) {
    this.challenges.push({ nonce: nonce.toLowerCase() as Hex, issuedAt, expiresAt, used: false });
  }
  async consumeChallenge(nonce: Hex, issuedAt: number, now: Date) {
    const c = this.challenges.find((x) => x.nonce === nonce.toLowerCase() && x.issuedAt === issuedAt);
    if (!c || c.used || c.expiresAt <= now) return false;
    c.used = true;
    return true;
  }
  async addSession(tokenHash: Hex, session: SocialSession) { this.sessions.set(tokenHash.toLowerCase() as Hex, session); }
  async session(tokenHash: Hex, now: Date) {
    const s = this.sessions.get(tokenHash.toLowerCase() as Hex);
    return s && s.expiresAt > now ? s : null;
  }
  private same(a: SocialTarget, b: SocialTarget) { return a.strategyId === b.strategyId && a.seq === b.seq; }
  async setLike(account: Address, target: SocialTarget, liked: boolean) {
    const i = this.likes.findIndex((l) => l.account === account && this.same(l, target));
    if (liked && i < 0) this.likes.push({ ...target, account });
    if (!liked && i >= 0) this.likes.splice(i, 1);
    return this.likes.filter((l) => this.same(l, target)).length;
  }
  private visible(c: CommentRecord) { return !c.deletedAt && !c.hiddenAt; }
  async counts(ids: readonly number[]) {
    const out: SocialCount[] = [];
    const entry = (t: SocialTarget) => {
      let e = out.find((x) => this.same(x, t));
      if (!e) out.push((e = { strategyId: t.strategyId, seq: t.seq, likes: 0, comments: 0 }));
      return e;
    };
    for (const l of this.likes) if (ids.includes(l.strategyId)) entry(l).likes++;
    for (const c of this.rows) {
      const parent = c.parentId === null ? null : this.rows.find((p) => p.id === c.parentId)!;
      if (ids.includes(c.strategyId) && this.visible(c) && (!parent || this.visible(parent))) entry(c).comments++;
    }
    return out;
  }
  async likedTargets(account: Address, ids: readonly number[]) {
    return this.likes.filter((l) => l.account === account && ids.includes(l.strategyId)).map(({ strategyId, seq }) => ({ strategyId, seq }));
  }
  async addComment(comment: CommentInsert, now: Date, limits: { perMinute: number; perDay: number }) {
    const mine = this.rows.filter((c) => c.account === comment.account);
    const since = (ms: number) => mine.filter((c) => c.createdAt.getTime() > now.getTime() - ms).length;
    if (since(60_000) >= limits.perMinute || since(86_400_000) >= limits.perDay) return "rate-limited" as const;
    const row: CommentRecord = { ...comment, id: this.rows.length + 1, createdAt: now, deletedAt: null, hiddenAt: null };
    this.rows.push(row);
    return { ...row };
  }
  async comment(id: number) { const c = this.rows.find((x) => x.id === id); return c ? { ...c } : null; }
  async topLevelComments(target: SocialTarget, beforeId: number | null, limit: number) {
    return this.rows
      .filter((c) => this.same(c, target) && c.parentId === null && this.visible(c) && (beforeId === null || c.id < beforeId))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  async replies(parentIds: readonly number[], perParent: number) {
    return parentIds.flatMap((p) =>
      this.rows.filter((c) => c.parentId === p && this.visible(c)).sort((a, b) => a.id - b.id).slice(0, perParent),
    );
  }
  async deleteComment(id: number, now: Date) { const c = this.rows.find((x) => x.id === id)!; c.deletedAt ??= now; }
  async reportComment(id: number, account: Address, reason: string | null, hideAt: number, now: Date) {
    if (!this.reports.some((r) => r.commentId === id && r.account === account)) this.reports.push({ commentId: id, account, reason });
    const c = this.rows.find((x) => x.id === id)!;
    if (!c.hiddenAt && this.reports.filter((r) => r.commentId === id).length >= hideAt) c.hiddenAt = now;
  }
  async hideComment(id: number, now: Date) { const c = this.rows.find((x) => x.id === id)!; c.hiddenAt ??= now; }
}

/** `clock.now` drives every use case that reads the time, so tests can move it forward. */
export function setup(jitter = 0) {
  const store = new MemoryStore();
  const registry = new FakeRegistry();
  const social = new MemorySocial();
  const relay = new StrategyRelay(store, registry, prices);
  const clock = { now: NOW };
  const now = () => clock.now;
  return {
    store,
    registry,
    social,
    relay,
    clock,
    create: new CreateStrategyUseCase(store, registry),
    submit: new SubmitCommitUseCase(store, registry, relay, jitter, () => 0.5),
    queries: new StrategyQueries(store, registry, social, now),
    sessions: new SocialSessions(social, store, registry.chainId, now),
    socialUse: new StrategySocial(social, store, now),
    prices: new ChangePriceUseCase(store, registry),
  };
}

export async function createInput(account = owner, terms = metadata, embargo = 60) {
  const deadline = NOW_S + 600;
  const signature = await account.signTypedData({
    domain: registryDomain(84532, REGISTRY),
    types: createStrategyTypes,
    primaryType: "CreateStrategy",
    message: { embargo, metadataHash: strategyMetadataHash(terms), deadline: BigInt(deadline) },
  });
  return { signer: owner.address, embargo, metadata: terms, deadline, signature };
}

export async function commitInput(strategyId: number, seq: number, account = owner) {
  const basket = sealBasket(basketInput, inStrategyUniverse);
  const commitment = basketCommitment(BigInt(strategyId), BigInt(seq), basket, SALT);
  const deadline = NOW_S + 600;
  const signature = await account.signTypedData({
    domain: registryDomain(84532, REGISTRY),
    types: commitStrategyTypes,
    primaryType: "Commit",
    message: { strategyId: BigInt(strategyId), seq: BigInt(seq), commitment, deadline: BigInt(deadline) },
  });
  return {
    seq,
    assets: basketInput,
    assetIds: basket.map((a) => a.assetId),
    weightsBps: basket.map((a) => a.weightBps),
    salt: SALT,
    commitment,
    signature,
    deadline,
  };
}
