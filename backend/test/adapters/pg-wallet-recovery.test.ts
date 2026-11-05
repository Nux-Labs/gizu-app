import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgWalletRecovery } from "../../src/adapters/postgres/pg-wallet-recovery.ts";
import { PgOperationCoordination } from "../../src/adapters/postgres/pg-operation-coordination.ts";
import { OperationCoordinator } from "../../src/adapters/earn/operation-coordinator.ts";
const database = process.env.TEST_DATABASE_URL;
async function isolated<T>(fn: (a: pg.Pool, b: pg.Pool) => Promise<T>) {
  const admin = new pg.Pool({ connectionString: database });
  const schema = `recovery_test_${randomBytes(8).toString("hex")}`;
  await admin.query(`create schema ${schema}`);
  const options = {
    connectionString: database,
    options: `-c search_path=${schema}`,
  };
  const a = new pg.Pool(options),
    b = new pg.Pool(options);
  try {
    return await fn(a, b);
  } finally {
    await a.end();
    await b.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}
test(
  "PostgreSQL recovery is race-safe across replicas, restart-persistent, authenticated and retains three ciphertext versions",
  { skip: !database },
  async () =>
    isolated(async (a, b) => {
      const id = randomBytes(32).toString("hex"),
        credential = randomBytes(32).toString("hex");
      const first = new PgWalletRecovery(a),
        second = new PgWalletRecovery(b);
      const creates = await Promise.allSettled([
        first.write(id, credential, 0, "opaque-ciphertext-one"),
        second.write(id, credential, 0, "opaque-ciphertext-two"),
      ]);
      assert.equal(
        creates.filter((v) => v.status === "rejected").length,
        0,
        "concurrent schema initialization and creation must succeed",
      );
      assert.deepEqual(
        creates
          .map((v) => (v.status === "fulfilled" ? v.value.status : "rejected"))
          .sort(),
        ["conflict", "ok"],
      );
      const revisions = await Promise.all([
        first.write(id, credential, 1, "encrypted-two"),
        second.write(id, credential, 1, "encrypted-competing"),
      ]);
      assert.deepEqual(revisions.map((v) => v.status).sort(), [
        "conflict",
        "ok",
      ]);
      await first.write(id, credential, 2, "encrypted-three");
      await second.write(id, credential, 3, "encrypted-four");
      assert.deepEqual(await new PgWalletRecovery(b).read(id, credential), {
        version: 1,
        revision: 4,
        ciphertext: "encrypted-four",
      });
      assert.equal(await second.read(id, "ff".repeat(32)), null);
      assert.deepEqual(await second.write(id, "ff".repeat(32), 4, "attacker"), {
        status: "missing",
      });
      const versions = await a.query(
        "select revision from wallet_recovery_versions order by revision",
      );
      assert.deepEqual(
        versions.rows.map((v) => v.revision),
        [2, 3, 4],
      );
      await second.remove(id, "ff".repeat(32));
      assert.equal((await second.read(id, credential))?.revision, 4);
      await second.remove(id, credential);
      assert.equal(await first.read(id, credential), null);
      assert.equal(
        (await a.query("select * from wallet_recovery_versions")).rowCount,
        0,
      );
      const columns = await a.query(
        "select column_name from information_schema.columns where table_schema=current_schema() and table_name like 'wallet_recovery_%'",
      );
      assert.equal(
        columns.rows.some((v) =>
          /address|user|token|payload|key/i.test(v.column_name),
        ),
        false,
      );
    }),
);
test(
  "PostgreSQL atomic opaque claims coordinate replicas and survive adapters restarting; expired rows are reusable and purgeable",
  { skip: !database },
  async () =>
    isolated(async (a, b) => {
      const key = "ab".repeat(32),
        identity = "0x" + "12".repeat(20);
      const first = new OperationCoordinator(
          new PgOperationCoordination(a),
          key,
        ),
        second = new OperationCoordinator(new PgOperationCoordination(b), key);
      const result = await Promise.allSettled([
        first.claim(
          "send",
          identity,
          { signature: "sensitive" },
          Date.now() + 60000,
        ),
        second.claim(
          "send",
          identity,
          { signature: "sensitive" },
          Date.now() + 60000,
        ),
      ]);
      assert.equal(result.filter((v) => v.status === "rejected").length, 0);
      assert.deepEqual(
        result
          .map((v) => (v.status === "fulfilled" ? v.value : "error"))
          .sort(),
        [false, true],
      );
      assert.equal(
        await new OperationCoordinator(
          new PgOperationCoordination(b),
          key,
        ).claim(
          "send",
          identity,
          { signature: "sensitive" },
          Date.now() + 60000,
        ),
        false,
      );
      await first.bind(
        "role",
        identity,
        { operation: "one" },
        Date.now() + 60000,
      );
      await second.bind(
        "role",
        identity,
        { operation: "one" },
        Date.now() + 60000,
      );
      await assert.rejects(
        second.bind("role", identity, { operation: "two" }, Date.now() + 60000),
      );
      const rows = await a.query("select * from earn_operation_coordination");
      assert.equal(JSON.stringify(rows.rows).includes(identity), false);
      assert.equal(JSON.stringify(rows.rows).includes("sensitive"), false);
      await a.query(
        "update earn_operation_coordination set expires_at=now()-interval '1 second'",
      );
      assert.equal(
        await second.claim(
          "send",
          identity,
          { signature: "different" },
          Date.now() + 60000,
        ),
        true,
      );
      await a.query(
        "update earn_operation_coordination set expires_at=now()-interval '1 second'",
      );
      await new PgOperationCoordination(a).purgeExpired();
      assert.equal(
        (await a.query("select * from earn_operation_coordination")).rowCount,
        0,
      );
    }),
);

test(
  "PostgreSQL recovery quota atomically bounds all opaque objects and retained bytes per credential",
  { skip: !database },
  async () =>
    isolated(async (a, b) => {
      const limits = { maxObjects: 2, maxCiphertextBytes: 120 };
      const first = new PgWalletRecovery(a, limits),
        second = new PgWalletRecovery(b, limits);
      const credential = "ab".repeat(32),
        ids = ["11", "22", "33"].map((v) => v.repeat(32)),
        ciphertext = Buffer.alloc(60, 7).toString("base64url");
      assert.equal(
        (await first.write(ids[0]!, credential, 0, ciphertext)).status,
        "ok",
      );
      const race = await Promise.all([
        first.write(ids[1]!, credential, 0, ciphertext),
        second.write(ids[2]!, credential, 0, ciphertext),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ["ok", "quota"]);
      assert.equal(
        (await first.write(ids[0]!, credential, 1, ciphertext)).status,
        "quota",
      );
      assert.equal(
        (await first.read(ids[0]!, credential))?.revision,
        1,
        "quota failure must roll back CAS and all ciphertext writes",
      );
      const owned = await a.query(
        "select opaque_id from wallet_recovery_objects where opaque_id <> $1",
        [ids[0]],
      );
      await first.remove(owned.rows[0].opaque_id, credential);
      assert.equal(
        (await second.write(ids[0]!, credential, 1, ciphertext)).status,
        "ok",
        "authenticated cleanup frees quota",
      );
    }),
);

test(
  "shared recovery upload admission bounds rotating credentials, bytes, TTL and total buckets with no readable IP persistence",
  { skip: !database },
  async () =>
    isolated(async (a, b) => {
      const { PgRecoveryUploadAdmission } =
        await import("../../src/adapters/postgres/pg-recovery-upload-admission.ts");
      const limits = {
        callsPerMinute: 2,
        bytesPerMinute: 120,
        bytesPerDay: 180,
        maxClients: 2,
      };
      const first = new PgRecoveryUploadAdmission(a, "ab".repeat(32), limits),
        second = new PgRecoveryUploadAdmission(b, "ab".repeat(32), limits);
      const ip = "192.0.2.123";
      const race = await Promise.all([
        first.admit(ip, 60),
        second.admit(ip, 60),
      ]);
      assert.deepEqual(race, [true, true]);
      assert.equal(
        await new PgRecoveryUploadAdmission(b, "ab".repeat(32), limits).admit(
          ip,
          1,
        ),
        false,
      );
      const saved = await a.query(
        "select * from wallet_recovery_upload_admission",
      );
      assert.equal(JSON.stringify(saved.rows).includes(ip), false);
      assert.match(saved.rows[0].client_commitment, /^[0-9a-f]{64}$/);
      await a.query(
        "update wallet_recovery_upload_admission set minute_at=now()-interval '2 minutes'",
      );
      assert.equal(await second.admit(ip, 60), true);
      assert.equal(
        await first.admit(ip, 1),
        false,
        "daily byte cap survives minute rollover",
      );
      assert.equal(await second.admit("192.0.2.124", 1), true);
      assert.equal(
        await first.admit("192.0.2.125", 1),
        false,
        "bucket table cardinality is hard bounded",
      );
      await a.query(
        "update wallet_recovery_upload_admission set expires_at=now()-interval '1 second'",
      );
      assert.equal(await second.admit("192.0.2.125", 1), true);
      assert.equal(
        (await a.query("select * from wallet_recovery_upload_admission"))
          .rowCount,
        1,
      );
      await assert.rejects(new PgRecoveryUploadAdmission(a).admit(ip, 1));
    }),
);
test(
  "global recovery capacity cannot be bypassed by rotating opaque credentials; cleanup frees capacity",
  { skip: !database },
  async () =>
    isolated(async (a, b) => {
      const limits = {
        maxObjects: 4096,
        maxCiphertextBytes: 1024,
        globalMaxObjects: 2,
        globalMaxCiphertextBytes: 120,
      };
      const first = new PgWalletRecovery(a, limits),
        second = new PgWalletRecovery(b, limits);
      const data = Buffer.alloc(60, 4).toString("base64url"),
        id = (v: string) => v.repeat(64);
      const results = await Promise.all([
        first.write(id("1"), id("a"), 0, data),
        second.write(id("2"), id("b"), 0, data),
        first.write(id("3"), id("c"), 0, data),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [
        "ok",
        "ok",
        "quota",
      ]);
      assert.equal(
        (
          await first.write(
            id("4"),
            id("d"),
            0,
            Buffer.alloc(1).toString("base64url"),
          )
        ).status,
        "quota",
      );
      const rows = await a.query(
        "select opaque_id,auth_digest from wallet_recovery_objects",
      );
      await second.remove(rows.rows[0].opaque_id, rows.rows[0].auth_digest);
      assert.equal((await first.write(id("4"), id("d"), 0, data)).status, "ok");
      const capacity = await a.query(
        "select objects,bytes from wallet_recovery_capacity",
      );
      assert.equal(capacity.rows[0].objects, "2");
      assert.equal(capacity.rows[0].bytes, "120");
    }),
);
