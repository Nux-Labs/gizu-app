import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerEarlyAccessRoutes } from "../../src/http/routes/early-access.routes.ts";

test("email signups are normalized, saved before success, and safe to retry", async () => {
  const emails = new Set<string>();
  const app = Fastify();
  registerEarlyAccessRoutes(app, {
    async add(signup) { emails.add(signup.email); },
  });
  for (const email of ["  Tester@Example.com  ", "tester@example.com"]) {
    const response = await app.inject({ method: "POST", url: "/v1/early-access", payload: { email } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "registered" });
  }
  assert.deepEqual([...emails], ["tester@example.com"]);
  await app.close();
});

test("request access retains the optional questionnaire answers", async () => {
  let saved: unknown;
  const app = Fastify();
  registerEarlyAccessRoutes(app, { async add(signup) { saved = signup; } });
  const response = await app.inject({ method: "POST", url: "/v1/early-access", payload: {
    email: "Tester@Example.com", investmentRange: "Under $500", platforms: ["Aave"], otherPlatform: "Other app",
  } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(saved, { email: "tester@example.com", investmentRange: "Under $500", platforms: ["Aave"], otherPlatform: "Other app" });
  await app.close();
});

test("invalid emails and unexpected fields never reach storage", async () => {
  let saves = 0;
  const app = Fastify();
  registerEarlyAccessRoutes(app, { async add() { saves++; } });
  for (const payload of [{}, { email: "" }, { email: "wrong" }, { email: "a@b.com", admin: true }, { email: "a".repeat(255) + "@b.com" }]) {
    const response = await app.inject({ method: "POST", url: "/v1/early-access", payload });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(saves, 0);
  await app.close();
});

test("database failures never report enrollment or disclose internals", async () => {
  const app = Fastify();
  registerEarlyAccessRoutes(app, { async add() { throw new Error("postgres://secret@private-db"); } });
  const response = await app.inject({ method: "POST", url: "/v1/early-access", payload: { email: "tester@example.com" } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("secret"), false);
  assert.equal(response.json().code, "SIGNUP_UNAVAILABLE");
  await app.close();
});

test("Gizu browser requests receive CORS headers and other origins are rejected", async () => {
  let saves = 0;
  const app = Fastify();
  registerEarlyAccessRoutes(app, { async add() { saves++; } });
  const preflight = await app.inject({ method: "OPTIONS", url: "/v1/early-access", headers: { origin: "https://gizu.io", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://gizu.io");
  const allowed = await app.inject({ method: "POST", url: "/v1/early-access", headers: { origin: "https://www.gizu.io" }, payload: { email: "tester@example.com" } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], "https://www.gizu.io");
  const denied = await app.inject({ method: "POST", url: "/v1/early-access", headers: { origin: "https://other.example" }, payload: { email: "tester@example.com" } });
  assert.equal(denied.statusCode, 403);
  const appPreflight = await app.inject({ method: "OPTIONS", url: "/v1/early-access", headers: { origin: "https://app.gizu.io", "access-control-request-method": "POST" } });
  assert.equal(appPreflight.statusCode, 204);
  assert.equal(appPreflight.headers["access-control-allow-origin"], "https://app.gizu.io");
  const appSignup = await app.inject({ method: "POST", url: "/v1/early-access", headers: { origin: "https://app.gizu.io" }, payload: { email: "app@example.com" } });
  assert.equal(appSignup.statusCode, 200);
  assert.equal(appSignup.headers["access-control-allow-origin"], "https://app.gizu.io");
  assert.equal(saves, 2);
  await app.close();
});

test("repeated signup attempts are rate limited", async () => {
  const app = Fastify();
  registerEarlyAccessRoutes(app, { async add() {} });
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.inject({ method: "POST", url: "/v1/early-access", payload: { email: "tester@example.com" } })).statusCode, 200);
  }
  const response = await app.inject({ method: "POST", url: "/v1/early-access", payload: { email: "tester@example.com" } });
  assert.equal(response.statusCode, 429);
  assert.ok(response.headers["retry-after"]);
  await app.close();
});
