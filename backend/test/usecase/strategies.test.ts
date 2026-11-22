import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
  OnchainStrategy,
  StrategyCommitInsert,
  StrategyCommitRecord,
  StrategyPriceSnapshot,
  StrategyRecord,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../src/ports/strategies.port.ts";
import { CreateStrategyUseCase } from "../../src/usecase/strategies/create-strategy.usecase.ts";
import { StrategyQueries } from "../../src/usecase/strategies/strategy-queries.usecase.ts";
import { StrategyRelay } from "../../src/usecase/strategies/strategy-relay.usecase.ts";
import { SubmitCommitUseCase } from "../../src/usecase/strategies/submit-commit.usecase.ts";

const { mnemonic } = JSON.parse(
  readFileSync(new URL("../../../shared/strategy-commit-vectors.json", import.meta.url), "utf8"),
) as { mnemonic: string };
const REGISTRY: Address = "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7";
const NOW = new Date("2026-11-23T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const owner = mnemonicToAccount(mnemonic, { path: "m/44'/60'/146'/84532'/0" });
const stranger = mnemonicToAccount(mnemonic, { path: "m/44'/60'/146'/84532'/1" });
const metadata: StrategyMetadata = { name: "AI chips", monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000", seats: 2 };
const basketInput: StrategyAsset[] = [
  { chainId: 8453, kind: 0, address: "0xb20000000000000000000078ee7ce2fE4908108C", weightBps: 6000 },
  { chainId: 8453, kind: 0, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weightBps: 3000 },
  { chainId: 4663, kind: 1, address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", weightBps: 1000 },
];
const SALT: Hex = `0x${"07".repeat(32)}`;

class MemoryStore implements StrategyStore {
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
    if (row.status === "pending" || row.status === "relaying") Object.assign(row, { status: "committed", commitTx: tx, committedAt: at });
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
  async earnedAtoms() { return new Map<number, bigint>(); }
  async registerPushDevice() { return "device"; }
  async followWithDevice() { return true; }
  async removePushDevice() {}
  async queueStrategyPush(strategyId: number, seq: number) { this.pushes.push({ strategyId, seq }); return 1; }
  async withWorkerLock(work: () => Promise<void>) { await work(); return true; }
}

class FakeRegistry implements StrategyRegistryGateway {
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

const prices = { prices: async (assets: readonly SealedStrategyAsset[]) => Object.fromEntries(assets.map((a) => [a.assetId, 10])) };

function setup(jitter = 0) {
  const store = new MemoryStore();
  const registry = new FakeRegistry();
  const relay = new StrategyRelay(store, registry, prices);
  return {
    store,
    registry,
    relay,
    create: new CreateStrategyUseCase(store, registry),
    submit: new SubmitCommitUseCase(store, registry, relay, jitter, () => 0.5),
    queries: new StrategyQueries(store, registry, () => NOW),
  };
}

async function createInput(account = owner, terms = metadata, embargo = 60) {
  const deadline = NOW_S + 600;
  const signature = await account.signTypedData({
    domain: registryDomain(84532, REGISTRY),
    types: createStrategyTypes,
    primaryType: "CreateStrategy",
    message: { embargo, metadataHash: strategyMetadataHash(terms), deadline: BigInt(deadline) },
  });
  return { signer: owner.address, embargo, metadata: terms, deadline, signature };
}

async function commitInput(strategyId: number, seq: number, account = owner) {
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

test("creating a strategy verifies the key's signature and is safe to retry", async () => {
  const { create, registry, store } = setup();
  await assert.rejects(create.execute(await createInput(stranger), NOW), { code: "STRATEGY_SIGNATURE_INVALID" });
  const first = await create.execute(await createInput(), NOW);
  assert.equal(first.id, 1);
  assert.equal((await create.execute(await createInput(), NOW)).id, 1);
  assert.equal(registry.chain.size, 1);
  await assert.rejects(create.execute(await createInput(owner, { ...metadata, seats: 3 }), NOW), { code: "STRATEGY_EXISTS" });

  // Created on chain by an attempt that never reached the database.
  store.strategies = [];
  assert.equal((await create.execute(await createInput(), NOW)).id, 1);
  assert.equal(registry.chain.size, 1);
});

test("a commitment is checked against the sealed basket, relayed, priced and queued for push", async () => {
  const { create, submit, store, registry, queries } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  const good = await commitInput(id, 0);

  await assert.rejects(submit.execute(id, { ...good, weightsBps: [...good.weightsBps].reverse() }, NOW), { code: "STRATEGY_COMMIT_MISMATCH" });
  await assert.rejects(submit.execute(id, { ...good, salt: `0x${"08".repeat(32)}` }, NOW), { code: "STRATEGY_COMMIT_MISMATCH" });
  await assert.rejects(submit.execute(id, await commitInput(id, 0, stranger), NOW), { code: "STRATEGY_SIGNATURE_INVALID" });
  await assert.rejects(submit.execute(id, await commitInput(id, 1), NOW), { code: "STRATEGY_SEQ_STALE" });
  await assert.rejects(
    submit.execute(id, { ...good, assets: [{ ...basketInput[0]!, address: "0x000000000000000000000000000000000000dEaD" }, ...basketInput.slice(1)] }, NOW),
    { code: "STRATEGY_INVALID" },
  );

  assert.deepEqual(await submit.execute(id, good, NOW), { seq: 0, status: "committed", commitTx: `0x${"c2".repeat(32)}` });
  assert.equal(registry.commitCalls, 1);
  assert.deepEqual(store.pushes, [{ strategyId: id, seq: 0 }]);
  assert.deepEqual(store.snaps.map((s) => [s.seq, s.edge]), [[0, "start"]]);

  // The second update closes the first period with end prices.
  await submit.execute(id, await commitInput(id, 1), NOW);
  assert.deepEqual(store.snaps.map((s) => [s.seq, s.edge]), [[0, "start"], [1, "start"], [0, "end"]]);
  assert.equal((await queries.detail(id)).commits, 2);
});

test("a delayed commitment waits for the worker and blocks a second update meanwhile", async () => {
  const { create, submit, relay, registry } = setup(300);
  const { id } = await create.execute(await createInput(), NOW);
  assert.deepEqual(await submit.execute(id, await commitInput(id, 0), NOW), { seq: 0, status: "pending", commitTx: null });
  assert.equal(registry.commitCalls, 0);
  await assert.rejects(submit.execute(id, await commitInput(id, 0), NOW), { code: "STRATEGY_COMMIT_PENDING" });
  await relay.runOnce(new Date(NOW.getTime() + 149_000));
  assert.equal(registry.commitCalls, 0);
  await relay.runOnce(new Date(NOW.getTime() + 151_000));
  assert.equal(registry.commitCalls, 1);
});

test("a lost receipt is reconciled from the chain instead of being marked failed", async () => {
  const { create, submit, relay, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  registry.loseNextReceipt = true;
  assert.equal((await submit.execute(id, await commitInput(id, 0), NOW)).status, "pending");
  await relay.runOnce(NOW);
  assert.equal(registry.commitCalls, 1, "the landed commitment is not sent again");
  const [row] = await store.commits([id]);
  assert.equal(row!.status, "committed");
  assert.equal(row!.commitTx, null);
  assert.deepEqual(store.pushes, [{ strategyId: id, seq: 0 }]);
});

test("a registry rejection fails the commitment and frees its sequence number", async () => {
  const { create, submit, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  registry.commit = async () => { throw new StrategyRegistryRejection("Expired"); };
  await assert.rejects(submit.execute(id, await commitInput(id, 0), NOW), { code: "STRATEGY_COMMIT_REJECTED" });
  assert.equal((await store.commits([id]))[0]!.status, "failed");
  registry.commit = FakeRegistry.prototype.commit.bind(registry);
  assert.equal((await submit.execute(id, await commitInput(id, 0), NOW)).status, "committed");
});

test("public reads show only revealed baskets; the signal needs a subscriber key", async () => {
  const { create, submit, relay, queries } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  await submit.execute(id, await commitInput(id, 0), NOW);

  const [card] = await queries.list();
  assert.equal(card!.commits, 1);
  assert.equal(card!.revealed, 0);
  const detail = await queries.detail(id);
  assert.deepEqual(detail.history, []);
  assert.ok(!JSON.stringify(await queries.list()).includes(basketInput[0]!.address.toLowerCase().slice(2)));

  await assert.rejects(queries.signal(id, undefined), { code: "PAYMENT_REQUIRED" });
  await assert.rejects(queries.signal(id, `0x${"ab".repeat(32)}`), { code: "PAYMENT_REQUIRED" });
  const { subscriberKey } = await queries.subscribe(id);
  const signal = await queries.signal(id, subscriberKey);
  assert.equal(signal.signal!.seq, 0);
  assert.deepEqual(signal.signal!.assets.map((a) => a.weightBps).sort(), [1000, 3000, 6000]);
  await queries.subscribe(id);
  await assert.rejects(queries.subscribe(id), { code: "STRATEGY_FULL" });

  // After the embargo the worker reveals it and it joins the public history.
  await relay.runOnce(new Date(NOW.getTime() + 60_000));
  const revealed = await queries.detail(id);
  assert.equal(revealed.revealed, 1);
  assert.equal(revealed.history[0]!.assets.length, 3);
  assert.equal(revealed.broken, false);
});
