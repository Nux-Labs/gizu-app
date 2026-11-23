import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { Hex } from "viem";
import { PgStrategies } from "../../../src/adapters/postgres/pg-strategies.ts";
import type { StrategyCommitInsert } from "../../../src/ports/strategies.port.ts";

const database = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-11-23T12:00:00Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const word = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const strategy = (id: number, signer: string) => ({
  id,
  signer: signer as `0x${string}`,
  embargoSeconds: 60,
  metadata: { name: `S${id}`, monthlyPriceAtoms: "1", signalPriceAtoms: "1", seats: 1 },
  metadataHash: word("e"),
  createTx: null,
  createdAt: NOW,
});
const commit = (strategyId: number, seq: number, digit: string): StrategyCommitInsert => ({
  strategyId,
  seq,
  commitment: word(digit),
  basket: [{ chainId: 8453, kind: 0, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weightBps: 10000, assetId: word("a") }],
  salt: word("5"),
  signature: `0x${"cd".repeat(64)}1b`,
  deadline: 2_000_000_000,
  relayAfter: NOW,
});

async function withSchema(work: (store: PgStrategies, pool: pg.Pool, schema: string) => Promise<void>) {
  const admin = new pg.Pool({ connectionString: database });
  const schema = `strategy_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  try {
    await work(new PgStrategies(pool, pool), pool, schema);
  } finally {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

test("strategies and commitments persist with retry-safe sequence numbers", { skip: !database }, async () => {
  await withSchema(async (store) => {
    await store.saveStrategy(strategy(1, "0x1cED07C44A78772081bc6490A05584dD4bfF15B5"));
    await store.saveStrategy({ ...strategy(1, "0x1cED07C44A78772081bc6490A05584dD4bfF15B5"), embargoSeconds: 999 });
    assert.equal((await store.strategy(1))!.embargoSeconds, 60);
    assert.equal((await store.strategyBySigner("0x1ced07c44a78772081bc6490a05584dd4bff15b5"))!.id, 1);
    assert.deepEqual((await store.listStrategies({ signers: ["0x0000000000000000000000000000000000000001"] })).length, 0);

    assert.equal(await store.addPendingCommit(commit(1, 0, "1")), true);
    assert.equal(await store.addPendingCommit(commit(1, 0, "2")), false);
    assert.equal(await store.claimRelay(1, 0, NOW), true);
    assert.equal(await store.claimRelay(1, 0, NOW), false, "a second sender cannot claim it");
    assert.deepEqual(await store.dueRelays(NOW, 10), []);
    assert.equal((await store.dueRelays(later(6 * 60), 10)).length, 1, "an abandoned claim returns");
    await store.markFailed(1, 0);
    assert.equal(await store.addPendingCommit(commit(1, 0, "3")), true, "a failed sequence number is free again");
    assert.equal((await store.commits([1]))[0]!.commitment, word("3"));

    await store.claimRelay(1, 0, NOW);
    await store.markCommitted(1, 0, null, NOW);
    await store.addPendingCommit(commit(1, 1, "4"));
    await store.markCommitted(1, 1, word("9"), later(10));
    assert.deepEqual((await store.dueReveals(later(59), 10)).length, 0);
    const due = await store.dueReveals(later(60), 10);
    assert.deepEqual(due.map((c) => c.seq), [0], "only the oldest unrevealed commitment is due");
    await store.markRevealed(1, 0, word("8"), later(61));
    assert.deepEqual((await store.dueReveals(later(80), 10)).map((c) => c.seq), [1]);
    const rows = await store.commits([1]);
    assert.deepEqual(rows.map((c) => c.status), ["revealed", "committed"]);
    assert.deepEqual(rows[0]!.basket, commit(1, 0, "3").basket);

    await store.saveSnapshot({ strategyId: 1, seq: 0, edge: "start", prices: { [word("a")]: 1.5 }, takenAt: NOW });
    await store.saveSnapshot({ strategyId: 1, seq: 0, edge: "start", prices: { [word("a")]: 9 }, takenAt: NOW });
    assert.deepEqual((await store.snapshots([1])).map((s) => s.prices), [{ [word("a")]: 1.5 }]);
  });
});

test("trial seats, earnings and push follows", { skip: !database }, async () => {
  await withSchema(async (store, pool) => {
    await store.saveStrategy(strategy(1, "0x1cED07C44A78772081bc6490A05584dD4bfF15B5"));
    assert.equal(await store.addTrialSubscription(1, word("1"), later(3600)), true);
    assert.equal(await store.addTrialSubscription(1, word("2"), later(3600)), false, "one seat only");
    assert.equal(await store.addTrialSubscription(2, word("3"), later(3600)), false, "unknown strategy");
    assert.equal(await store.hasSubscription(1, word("1"), NOW), true);
    assert.equal(await store.hasSubscription(1, word("1"), later(7200)), false);
    assert.deepEqual([...(await store.seatsTaken([1], NOW))], [[1, 1]]);

    await pool.query("insert into strategy_payments (strategy_id, kind, amount_atoms, reference) values (1, 'x402', 500000, 'a'), (1, 'x402', 250000, 'b')");
    assert.deepEqual([...(await store.earnedAtoms([1]))], [[1, 750000n]]);

    const device = await store.registerPushDevice("token-".padEnd(32, "x"), "android");
    assert.equal(await store.registerPushDevice("token-".padEnd(32, "x"), "android"), device);
    assert.equal(await store.followWithDevice(device, 1), true);
    assert.equal(await store.followWithDevice(device, 1), true);
    assert.equal(await store.followWithDevice(device, 2), false);
    assert.equal(await store.queueStrategyPush(1, 0), 1);
    assert.equal(await store.queueStrategyPush(1, 0), 0);
    await store.removePushDevice(device);
    assert.equal((await pool.query("select count(*)::int as n from push_outbox")).rows[0].n, 0);
  });
});

test("only one instance runs the worker at a time", { skip: !database }, async () => {
  await withSchema(async (store, pool) => {
    const other = new PgStrategies(pool, pool);
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    const first = store.withWorkerLock(() => holding);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await other.withWorkerLock(async () => assert.fail("must not run")), false);
    release();
    assert.equal(await first, true);
    assert.equal(await other.withWorkerLock(async () => {}), true);
  });
});

test("concurrent trial sign-ups never exceed the seat limit", { skip: !database }, async () => {
  await withSchema(async (store) => {
    await store.saveStrategy(strategy(1, "0x1cED07C44A78772081bc6490A05584dD4bfF15B5"));
    const results = await Promise.all(
      ["1", "2", "3", "4", "5"].map((digit) => store.addTrialSubscription(1, word(digit), later(3600))),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual([...(await store.seatsTaken([1], NOW))], [[1, 1]]);
  });
});

test("the chain can correct a commitment recorded as failed", { skip: !database }, async () => {
  await withSchema(async (store) => {
    await store.saveStrategy(strategy(1, "0x1cED07C44A78772081bc6490A05584dD4bfF15B5"));
    await store.addPendingCommit(commit(1, 0, "1"));
    await store.markFailed(1, 0);
    await store.markCommitted(1, 0, null, NOW);
    assert.equal((await store.commits([1]))[0]!.status, "committed");
  });
});
