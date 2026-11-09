import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgMinimumReturnStore } from "../../../src/adapters/postgres/pg-minimum-return.ts";
import type { MinimumReturnReceipt } from "../../../src/ports/minimum-return.port.ts";
const databaseUrl = process.env.MINIMUM_RETURN_TEST_DATABASE_URL;
const opaque = () => randomBytes(32).toString("hex");
const receipt = (): MinimumReturnReceipt => ({
  accountKey: opaque(),
  routeKey: opaque(),
  commitment: opaque(),
  sequence: "0",
  minimumAtoms: "990000",
  observedAtMs: 1794218400000,
});
test(
  "PostgreSQL locks sequence and receipt atomically across replicas, retries and restarts",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    try {
      const first = new PgMinimumReturnStore(pool),
        second = new PgMinimumReturnStore(pool),
        original = receipt();
      assert.equal(await first.sequence(original.accountKey), "0");
      const same = await Promise.all([
        first.finish(original),
        second.finish({
          ...original,
          observedAtMs: original.observedAtMs + 1000,
        }),
      ]);
      assert.deepEqual(same[0], same[1]);
      assert.ok(
        [original.observedAtMs, original.observedAtMs + 1000].includes(
          same[0]!.observedAtMs,
        ),
      );
      assert.equal(await second.sequence(original.accountKey), "1");
      assert.deepEqual(
        await new PgMinimumReturnStore(pool).receipt(original.routeKey),
        same[0],
      );
      assert.equal(
        await second.finish({ ...original, commitment: opaque() }),
        undefined,
      );
      assert.equal(
        await second.finish({
          ...original,
          routeKey: opaque(),
          commitment: opaque(),
        }),
        undefined,
      );
      assert.equal(await second.sequence(original.accountKey), "1");
      const a = {
        ...receipt(),
        accountKey: original.accountKey,
        sequence: "1",
      };
      const b = { ...a, routeKey: opaque(), commitment: opaque() };
      const competing = await Promise.all([first.finish(a), second.finish(b)]);
      assert.equal(competing.filter(Boolean).length, 1);
      assert.equal(await first.sequence(original.accountKey), "2");
      const route = opaque(),
        left = { ...receipt(), routeKey: route },
        right = { ...receipt(), routeKey: route };
      const duplicate = await Promise.all([
        first.finish(left),
        second.finish(right),
      ]);
      assert.equal(duplicate.filter(Boolean).length, 1);
      assert.equal(
        BigInt(await first.sequence(left.accountKey)) +
          BigInt(await second.sequence(right.accountKey)),
        1n,
      );
    } finally {
      await pool.end();
    }
  },
);
test("PostgreSQL errors remain failures and never create a local coordination fallback", async () => {
  const pool = {
    async query() {
      throw Error("db unavailable");
    },
    async connect() {
      throw Error("db unavailable");
    },
  } as unknown as pg.Pool;
  const store = new PgMinimumReturnStore(pool);
  await assert.rejects(store.sequence(opaque()));
  await assert.rejects(store.receipt(opaque()));
  await assert.rejects(store.finish(receipt()));
});
