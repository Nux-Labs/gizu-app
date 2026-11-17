import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import Fastify from "fastify";
import { PgEarlyAccess } from "../../src/adapters/postgres/pg-early-access.ts";
import { registerEarlyAccessRoutes } from "../../src/http/routes/early-access.routes.ts";

test("PostgreSQL retains one signup with its original timestamp and merged preferences", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `signup_test_${randomUUID().replaceAll("-", "")}`;
  const app = Fastify();
  try {
    await client.query("begin");
    await client.query(`create schema ${schema}`);
    await client.query(`set local search_path to ${schema}`);
    registerEarlyAccessRoutes(app, new PgEarlyAccess(client));
    const response = await app.inject({ method: "POST", url: "/v1/early-access", payload: {
      email: "  Tester@Example.com  ", investmentRange: "Under $500", platforms: ["Aave"],
    } });
    assert.equal(response.statusCode, 200);
    const before = await client.query("select * from early_access_signups");
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].email, "tester@example.com");
    assert.ok(before.rows[0].created_at instanceof Date);
    // A new adapter exercises the same row after the schema has already been created.
    await new PgEarlyAccess(client).add({ email: "TESTER@example.com" });
    await new PgEarlyAccess(client).add({ email: "tester@example.com", otherPlatform: "Another app" });
    const after = await client.query("select * from early_access_signups");
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].created_at.toISOString(), before.rows[0].created_at.toISOString());
    assert.deepEqual(after.rows[0].preferences, { investmentRange: "Under $500", platforms: ["Aave"], otherPlatform: "Another app" });
    const landing = { email: "TESTER@example.com", platform: "both", source: "landing-footer", consent: true, consentVersion: "2026-11-17" };
    for (let i = 0; i < 2; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/v1/early-access", payload: landing })).statusCode, 200);
    }
    const final = await client.query("select * from early_access_signups");
    assert.equal(final.rows.length, 1);
    assert.equal(final.rows[0].preferences.platform, "both");
    assert.equal(final.rows[0].preferences.consent, true);
    assert.ok(Number.isFinite(Date.parse(final.rows[0].preferences.consentRecordedAt)));
    assert.equal(final.rows[0].preferences.investmentRange, "Under $500");
    assert.equal(final.rows[0].created_at.toISOString(), before.rows[0].created_at.toISOString());
  } finally {
    await app.close();
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
