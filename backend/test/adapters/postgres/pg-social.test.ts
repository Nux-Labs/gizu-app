import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { Address, Hex } from "viem";
import { PgSocial } from "../../../src/adapters/postgres/pg-social.ts";
import { PgStrategies } from "../../../src/adapters/postgres/pg-strategies.ts";

const database = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-11-23T12:00:00Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const word = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const alice: Address = "0x1cED07C44A78772081bc6490A05584dD4bfF15B5";
const bob: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const carol: Address = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const limits = { perMinute: 5, perDay: 100 };

async function withSchema(work: (social: PgSocial, strategies: PgStrategies, pool: pg.Pool) => Promise<void>) {
  const admin = new pg.Pool({ connectionString: database });
  const schema = `social_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  try {
    const strategies = new PgStrategies(pool, pool);
    await strategies.saveStrategy({
      id: 1,
      signer: alice,
      embargoSeconds: 60,
      metadata: { name: "S1", monthlyPriceAtoms: "1", signalPriceAtoms: "1", seats: 1 },
      metadataHash: word("e"),
      createTx: null,
      createdAt: NOW,
    });
    await work(new PgSocial(pool, strategies, pool), strategies, pool);
  } finally {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

const comment = (account: Address, extra: { seq?: number | null; parentId?: number | null; body?: string } = {}) => ({
  strategyId: 1,
  seq: extra.seq ?? null,
  parentId: extra.parentId ?? null,
  account,
  owner: false,
  body: extra.body ?? "hello",
});

test("challenges are single use and sessions are found by token hash until they expire", { skip: !database }, async () => {
  await withSchema(async (social) => {
    await social.addChallenge(word("A"), 100, later(300));
    assert.equal(await social.consumeChallenge(word("a"), 101, NOW), false, "issuedAt must match");
    assert.equal(await social.consumeChallenge(word("a"), 100, later(300)), false, "expired");
    assert.equal(await social.consumeChallenge(word("a"), 100, NOW), true);
    assert.equal(await social.consumeChallenge(word("a"), 100, NOW), false, "used");

    await social.addSession(word("b"), { account: alice, ownerOf: 1, expiresAt: later(60) });
    assert.deepEqual(await social.session(word("B"), NOW), { account: alice, ownerOf: 1, expiresAt: later(60) });
    assert.equal(await social.session(word("b"), later(60)), null);
  });
});

test("likes are idempotent per target and counted with visible comments", { skip: !database }, async () => {
  await withSchema(async (social) => {
    assert.equal(await social.setLike(alice, { strategyId: 1, seq: null }, true), 1);
    assert.equal(await social.setLike(alice, { strategyId: 1, seq: null }, true), 1);
    assert.equal(await social.setLike(bob, { strategyId: 1, seq: null }, true), 2);
    assert.equal(await social.setLike(alice, { strategyId: 1, seq: 0 }, true), 1);
    assert.equal(await social.setLike(bob, { strategyId: 1, seq: null }, false), 1);
    assert.equal(await social.setLike(bob, { strategyId: 1, seq: null }, false), 1);
    assert.deepEqual(
      (await social.likedTargets(alice, [1])).sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1)),
      [{ strategyId: 1, seq: null }, { strategyId: 1, seq: 0 }],
    );

    const top = await social.addComment(comment(bob), NOW, limits);
    assert.ok(top !== "rate-limited");
    await social.addComment(comment(carol, { parentId: top.id }), NOW, limits);
    await social.addComment(comment(carol, { seq: 0 }), NOW, limits);
    const sort = (rows: { seq: number | null }[]) => rows.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
    assert.deepEqual(sort(await social.counts([1])), [
      { strategyId: 1, seq: null, likes: 1, comments: 2 },
      { strategyId: 1, seq: 0, likes: 1, comments: 1 },
    ]);
    // A hidden parent takes its replies out of the count.
    await social.hideComment(top.id, NOW);
    assert.deepEqual(sort(await social.counts([1]))[0], { strategyId: 1, seq: null, likes: 1, comments: 0 });
  });
});

test("comments page newest first, replies oldest first, and reports hide at three accounts", { skip: !database }, async () => {
  await withSchema(async (social) => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const row = await social.addComment(comment([alice, bob, carol][i % 3]!, { body: `c${i}` }), later(i * 61), limits);
      assert.ok(row !== "rate-limited");
      ids.push(row.id);
    }
    const wall = { strategyId: 1, seq: null };
    assert.deepEqual((await social.topLevelComments(wall, null, 2)).map((c) => c.body), ["c3", "c2"]);
    assert.deepEqual((await social.topLevelComments(wall, ids[2]!, 10)).map((c) => c.body), ["c1", "c0"]);
    assert.deepEqual(await social.topLevelComments({ strategyId: 1, seq: 0 }, null, 10), []);

    for (let i = 0; i < 3; i++) await social.addComment(comment(bob, { parentId: ids[0]!, body: `r${i}` }), later(600 + i * 61), limits);
    assert.deepEqual((await social.replies([ids[0]!, ids[1]!], 2)).map((c) => c.body), ["r0", "r1"]);

    await social.deleteComment(ids[3]!, NOW);
    assert.equal((await social.comment(ids[3]!))!.deletedAt!.getTime(), NOW.getTime());
    await social.reportComment(ids[2]!, alice, "spam", 3, NOW);
    await social.reportComment(ids[2]!, alice, "again", 3, NOW);
    await social.reportComment(ids[2]!, bob, null, 3, NOW);
    assert.equal((await social.comment(ids[2]!))!.hiddenAt, null);
    await social.reportComment(ids[2]!, carol, null, 3, NOW);
    assert.ok((await social.comment(ids[2]!))!.hiddenAt);
    assert.deepEqual((await social.topLevelComments(wall, null, 10)).map((c) => c.body), ["c1", "c0"]);
  });
});

test("concurrent comments from one account never pass the per-minute limit", { skip: !database }, async () => {
  await withSchema(async (social) => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => social.addComment(comment(alice, { body: `b${i}` }), NOW, limits)),
    );
    assert.equal(results.filter((r) => r !== "rate-limited").length, 5);
    assert.notEqual(await social.addComment(comment(bob), NOW, limits), "rate-limited");
    assert.notEqual(await social.addComment(comment(alice), later(61), limits), "rate-limited");
  });
});

test("price changes keep their versions and notify followers under negative sequence numbers", { skip: !database }, async () => {
  await withSchema(async (_social, strategies) => {
    const change = { strategyId: 1, version: 1, monthlyPriceAtoms: "999999999999", signalPriceAtoms: "0", signature: word("c"), deadline: 2_000_000_000, at: NOW };
    assert.equal(await strategies.addPriceChange(change), true);
    assert.equal(await strategies.addPriceChange({ ...change, monthlyPriceAtoms: "5" }), false);
    assert.equal(await strategies.addPriceChange({ ...change, version: 2, at: later(60) }), true);
    assert.deepEqual(
      (await strategies.priceChanges([1])).map((c) => [c.version, c.monthlyPriceAtoms, c.signalPriceAtoms, c.at.getTime()]),
      [[1, "999999999999", "0", NOW.getTime()], [2, "999999999999", "0", later(60).getTime()]],
    );

    const device = await strategies.registerPushDevice("token-".padEnd(32, "x"), "android");
    await strategies.followWithDevice(device, 1);
    assert.equal(await strategies.queuePricePush(1, 1), 1);
    assert.equal(await strategies.queuePricePush(1, 1), 0);
    assert.equal(await strategies.queueStrategyPush(1, 0), 1);
    // One neutral notification covers the update and the price change.
    const pending = await strategies.pendingPushes(10);
    assert.equal(pending.length, 1);
    await strategies.finishPush(pending[0]!, "sent");
    assert.deepEqual(await strategies.pendingPushes(10), []);
    assert.equal(await strategies.queuePricePush(1, 2), 1);
    const price = await strategies.pendingPushes(10);
    assert.deepEqual(price.map((p) => p.seq), [-2]);
    await strategies.finishPush(price[0]!, "sent");
    assert.deepEqual(await strategies.pendingPushes(10), []);
  });
});
