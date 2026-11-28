import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerAdminEarlyAccessRoutes } from "../../src/http/routes/admin-early-access.routes.ts";
import type { EarlyAccessRecord } from "../../src/ports/early-access.port.ts";

const token = "t".repeat(40);
const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
const signups: EarlyAccessRecord[] = [
  { email: "new@example.com", createdAt: new Date("2026-11-20T10:00:00Z"), platform: "ios", source: "landing-ios", consent: true, consentRecordedAt: "2026-11-20T10:00:00.000Z" },
  { email: "=cmd<b>@example.com", createdAt: new Date("2026-11-01T10:00:00Z"), platform: null, source: null, consent: false, consentRecordedAt: null },
];

function build(list: () => Promise<EarlyAccessRecord[]> = async () => signups) {
  const app = Fastify();
  registerAdminEarlyAccessRoutes(app, { list }, token);
  return app;
}

test("admin views require the configured token and never reach storage otherwise", async () => {
  let reads = 0;
  const app = build(async () => { reads++; return signups; });
  for (const authorization of [undefined, basic("wrong"), basic(token.slice(1)), `Bearer ${token}`, "Basic"]) {
    for (const url of ["/admin/early-access", "/admin/early-access.csv"]) {
      const response = await app.inject({ method: "GET", url, headers: authorization ? { authorization } : {} });
      assert.equal(response.statusCode, 401);
      assert.match(String(response.headers["www-authenticate"]), /^Basic /);
      assert.equal(response.headers["cache-control"], "no-store");
    }
  }
  assert.equal(reads, 0);
  await app.close();
});

test("the HTML view lists signups with escaped values and private headers", async () => {
  const app = build();
  const response = await app.inject({ method: "GET", url: "/admin/early-access", headers: { authorization: basic(token) } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/html/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["x-robots-tag"]), /noindex/);
  assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(response.body, /2 total/);
  assert.match(response.body, /new@example\.com/);
  assert.equal(response.body.includes("<b>@example"), false);
  assert.match(response.body, /&#60;b&#62;@example\.com/);
  await app.close();
});

test("the CSV download is an attachment with formula-safe cells", async () => {
  const app = build();
  const response = await app.inject({ method: "GET", url: "/admin/early-access.csv", headers: { authorization: basic(token) } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/csv/);
  assert.match(String(response.headers["content-disposition"]), /^attachment; filename="gizu-early-access-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(response.body, [
    "email,created_at,source,platform,consent,consent_recorded_at",
    '"new@example.com","2026-11-20T10:00:00.000Z","landing-ios","ios","yes","2026-11-20T10:00:00.000Z"',
    `"'=cmd<b>@example.com","2026-11-01T10:00:00.000Z","","","",""`,
    "",
  ].join("\r\n"));
  await app.close();
});

test("storage failures return 503 without leaking internals", async () => {
  const app = build(async () => { throw new Error("postgres://secret@private-db"); });
  for (const url of ["/admin/early-access", "/admin/early-access.csv"]) {
    const response = await app.inject({ method: "GET", url, headers: { authorization: basic(token) } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("secret"), false);
  }
  await app.close();
});
