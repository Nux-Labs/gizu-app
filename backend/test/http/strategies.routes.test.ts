import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { DomainError } from "../../src/domain/errors/domain-error.ts";
import { mapRequestError } from "../../src/http/map-request-error.ts";
import { registerPrivateHttp, privateHttpOptions } from "../../src/http/private-http.ts";
import { registerPushRoutes } from "../../src/http/routes/push.routes.ts";
import { registerStrategyRoutes } from "../../src/http/routes/strategies.routes.ts";
import { paymentRequired } from "../../src/usecase/strategies/strategy-queries.usecase.ts";

const word = `0x${"ab".repeat(32)}`;
const signature = `0x${"cd".repeat(64)}1b`;
const signer = "0x1cED07C44A78772081bc6490A05584dD4bfF15B5";

function build() {
  const calls: Record<string, unknown[]> = { create: [], submit: [], list: [], signal: [], follow: [] };
  const app = Fastify(privateHttpOptions);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerPrivateHttp(app);
  registerStrategyRoutes(app, {
    create: { execute: async (input) => { calls.create!.push(input); return { id: 7 } as never; } },
    submit: {
      execute: async (id, input) => {
        calls.submit!.push([id, input]);
        if (input.seq === 9) throw new DomainError("STRATEGY_SEQ_STALE", "stale with private detail");
        return { seq: input.seq, status: "pending", commitTx: null };
      },
    },
    queries: {
      list: async (signers) => { calls.list!.push(signers); return []; },
      detail: async (id) => ({ id }) as never,
      subscribe: async () => ({ subscriberKey: word as `0x${string}`, expiresAt: "2026-12-23T00:00:00.000Z" }),
      signal: async (id, key) => {
        calls.signal!.push([id, key]);
        if (!key) throw paymentRequired();
        return { strategyId: id, registry: { chainId: 84532, address: signer }, signal: null };
      },
    },
  });
  registerPushRoutes(app, {
    registerPushDevice: async () => "6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f",
    followWithDevice: async (deviceId, id) => { calls.follow!.push([deviceId, id]); return id === 7; },
    removePushDevice: async () => {},
  });
  app.setErrorHandler(mapRequestError);
  return { app, calls };
}

const createBody = {
  signer,
  embargo: 604800,
  metadata: { name: "AI chips", monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000", seats: 20 },
  deadline: 2_000_000_000,
  signature,
};
const commitBody = {
  seq: 0,
  assets: [{ chainId: 8453, kind: 0, address: signer.toLowerCase(), weightBps: 10000 }],
  assetIds: [word],
  weightsBps: [10000],
  salt: word,
  commitment: word,
  signature,
  deadline: 2_000_000_000,
};

test("strategy creation validates the body strictly and returns the stored card", async () => {
  const { app, calls } = build();
  const created = await app.inject({ method: "POST", url: "/v1/strategies", payload: createBody });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), { id: 7 });
  for (const payload of [
    { ...createBody, extra: true },
    { ...createBody, signature: "0x1234" },
    { ...createBody, metadata: { ...createBody.metadata, name: " padded" } },
    { ...createBody, metadata: { ...createBody.metadata, monthlyPriceAtoms: "01" } },
    { ...createBody, metadata: { ...createBody.metadata, seats: 0 } },
  ])
    assert.equal((await app.inject({ method: "POST", url: "/v1/strategies", payload })).statusCode, 400);
  assert.equal(calls.create!.length, 1);
  await app.close();
});

test("commit, subscription and signal routes are private: no-store and sanitized errors", async () => {
  const { app, calls } = build();
  const accepted = await app.inject({ method: "POST", url: "/v1/strategies/7/commits", payload: commitBody });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.headers["cache-control"], "no-store");

  const stale = await app.inject({ method: "POST", url: "/v1/strategies/7/commits", payload: { ...commitBody, seq: 9 } });
  assert.equal(stale.statusCode, 400);
  assert.equal(stale.json().code, "STRATEGY_SEQ_STALE");
  assert.ok(!stale.body.includes("private detail"));

  const invalid = await app.inject({ method: "POST", url: "/v1/strategies/7/commits", payload: { ...commitBody, salt: "0x12" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "VALIDATION_ERROR");

  const unpaid = await app.inject("/v1/strategies/7/signal");
  assert.equal(unpaid.statusCode, 402);
  assert.equal(unpaid.json().code, "PAYMENT_REQUIRED");
  assert.equal(unpaid.headers["cache-control"], "no-store");
  const paid = await app.inject({ url: "/v1/strategies/7/signal", headers: { "x-subscriber-key": word } });
  assert.equal(paid.statusCode, 200);
  assert.deepEqual(calls.signal!.at(-1), [7, word]);

  const subscription = await app.inject({ method: "POST", url: "/v1/strategies/7/subscriptions" });
  assert.equal(subscription.statusCode, 201);
  assert.equal(subscription.headers["cache-control"], "no-store");

  const listed = await app.inject("/v1/strategies");
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["cache-control"], undefined);
  await app.close();
});

test("the list filters by checksummed signers and rejects malformed ones", async () => {
  const { app, calls } = build();
  assert.equal((await app.inject(`/v1/strategies?signers=${signer.toLowerCase()}`)).statusCode, 200);
  assert.deepEqual(calls.list!.at(-1), [signer]);
  assert.equal((await app.inject("/v1/strategies?signers=0x1234")).statusCode, 400);
  assert.equal((await app.inject("/v1/strategies/abc")).statusCode, 400);
  await app.close();
});

test("push devices register by token and follow strategies by id", async () => {
  const { app, calls } = build();
  const device = await app.inject({ method: "POST", url: "/v1/push/devices", payload: { token: "f".repeat(32), platform: "android" } });
  assert.equal(device.statusCode, 201);
  assert.equal(device.headers["cache-control"], "no-store");
  const deviceId = device.json().deviceId;
  assert.equal((await app.inject({ method: "PUT", url: `/v1/push/devices/${deviceId}/strategies/7` })).statusCode, 204);
  assert.equal((await app.inject({ method: "PUT", url: `/v1/push/devices/${deviceId}/strategies/8` })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: "/v1/push/devices/not-a-uuid/strategies/7" })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/push/devices", payload: { token: "short", platform: "android" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/push/devices/${deviceId}` })).statusCode, 204);
  assert.deepEqual(calls.follow, [[deviceId, 7], [deviceId, 8]]);
  await app.close();
});

test("strategy creation is limited per IP and in total, since it spends relayer gas", async () => {
  const app = Fastify(privateHttpOptions);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerPrivateHttp(app);
  let created = 0;
  registerStrategyRoutes(
    app,
    {
      create: { execute: async () => ({ id: ++created }) as never },
      submit: { execute: async () => ({ seq: 0, status: "committed", commitTx: null }) },
      queries: {
        list: async () => [],
        detail: async (id) => ({ id }) as never,
        subscribe: async () => ({ subscriberKey: word as `0x${string}`, expiresAt: "" }),
        signal: async () => ({ strategyId: 1, registry: { chainId: 84532, address: signer }, signal: null }),
      },
    },
    {
      create: { perIp: 2, total: 3, windowMs: 60_000 },
      commit: { perIp: 1, windowMs: 60_000 },
      subscribe: { perIp: 1, windowMs: 60_000 },
    },
  );
  app.setErrorHandler(mapRequestError);
  const post = (ip: string) =>
    app.inject({ method: "POST", url: "/v1/strategies", payload: createBody, remoteAddress: ip });
  assert.equal((await post("10.0.0.1")).statusCode, 201);
  assert.equal((await post("10.0.0.1")).statusCode, 201);
  const limited = await post("10.0.0.1");
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal((await post("10.0.0.2")).statusCode, 201);
  assert.equal((await post("10.0.0.3")).statusCode, 429, "the total limit holds across IPs");
  assert.equal(created, 3);

  assert.equal((await app.inject({ method: "POST", url: "/v1/strategies/1/subscriptions" })).statusCode, 201);
  const seat = await app.inject({ method: "POST", url: "/v1/strategies/1/subscriptions" });
  assert.equal(seat.statusCode, 429);
  assert.equal(seat.headers["cache-control"], "no-store");
  await app.close();
});
