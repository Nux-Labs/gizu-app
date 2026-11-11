import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgOperationCoordination } from "../../../src/adapters/postgres/pg-operation-coordination.ts";
import {
  CoordinationError,
  OperationCoordinator,
} from "../../../src/adapters/earn/operation-coordinator.ts";
const opaque = () => randomBytes(32).toString("hex");
test(
  "atomic coordination batch preserves exact legacy claims and rolls every new claim back on conflict",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "coordination_test_" + randomBytes(8).toString("hex");
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await admin.query(`create schema ${schema}`);
      const store = new PgOperationCoordination(pool),
        until = Date.now() + 60000;
      const legacyKey = opaque(),
        legacy = opaque(),
        proofKey = opaque(),
        proof = opaque(),
        giftKey = opaque();
      await store.bind(legacyKey, legacy, until, false);
      assert.equal(
        await store.bindMany([
          { opaqueKey: proofKey, commitments: [proof], expiresAtMs: until },
          {
            opaqueKey: legacyKey,
            commitments: [opaque(), legacy],
            expiresAtMs: until,
          },
        ]),
        true,
      );
      assert.equal(
        (
          await pool.query(
            "select commitment from earn_operation_coordination where opaque_key=$1",
            [legacyKey],
          )
        ).rows[0].commitment,
        legacy,
      );
      const size = Number(
        (await pool.query("select count(*) from earn_operation_coordination"))
          .rows[0].count,
      );
      assert.equal(
        await store.bindMany([
          { opaqueKey: giftKey, commitments: [opaque()], expiresAtMs: until },
          { opaqueKey: proofKey, commitments: [opaque()], expiresAtMs: until },
        ]),
        false,
      );
      assert.equal(
        Number(
          (await pool.query("select count(*) from earn_operation_coordination"))
            .rows[0].count,
        ),
        size,
      );
      assert.equal(await store.bind(giftKey, opaque(), until, false), true);
      const newKey = opaque();
      assert.equal(
        await store.bindMany([
          { opaqueKey: newKey, commitments: [opaque()], expiresAtMs: until },
          {
            opaqueKey: opaque(),
            commitments: [opaque()],
            expiresAtMs: Date.now() - 1000,
          },
        ]),
        false,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*) from earn_operation_coordination where opaque_key=$1",
            [newKey],
          )
        ).rows[0].count,
        "0",
      );
      const shared = opaque(),
        a = opaque(),
        b = opaque();
      const race = await Promise.all([
        store.bindMany([
          { opaqueKey: shared, commitments: [a], expiresAtMs: until },
        ]),
        new PgOperationCoordination(pool).bindMany([
          { opaqueKey: shared, commitments: [b], expiresAtMs: until },
        ]),
      ]);
      assert.equal(race.filter(Boolean).length, 1);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  },
);
test("atomic coordinator requires durable batch capability and sanitizes store failures", async () => {
  const unavailable = new OperationCoordinator(
    { bind: async () => true },
    "aa".repeat(32),
  );
  await assert.rejects(
    () => unavailable.bindMany([], Date.now() + 60000),
    (e: any) => e instanceof CoordinationError && e.statusCode === 503,
  );
  const failing = new OperationCoordinator(
    {
      bind: async () => true,
      bindMany: async () => {
        throw Error("private provider details");
      },
    },
    "aa".repeat(32),
  );
  await assert.rejects(
    () => failing.bindMany([], Date.now() + 60000),
    (e: any) =>
      e instanceof CoordinationError && !e.message.includes("private provider"),
  );
});
