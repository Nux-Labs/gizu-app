import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { registerSwapRoutes } from "../../src/http/routes/swap.routes.ts";
import { mapRequestError } from "../../src/http/map-request-error.ts";

const wallet = "0x8ba1f109551bd432803012645ac136ddd64dba72";
const amzn = "0x12f190a9F9d7D37a250758b26824B97CE941bF54";

function build(calls: unknown[][]) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  const record = (name: string, result: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return result;
  };
  // Calls to the Base adapter are recorded with a "base:" prefix.
  const fusion = (prefix: string) => ({
    preview: record(`${prefix}preview`, {}),
    permitContext: record(`${prefix}permitContext`, {}),
    createOrder: record(`${prefix}createOrder`, {}),
    submit: record(`${prefix}submit`, undefined),
    status: record(`${prefix}status`, null),
  });
  registerSwapRoutes(app, {
    aurora: {
      tokens: record("tokens", []),
      quote: record("quote", { quote: {} }),
      generateIntent: record("generateIntent", { intent: {} }),
      submitIntent: record("submitIntent", { intentHash: "h" }),
      status: record("status", { status: "PENDING_DEPOSIT" }),
      authSalt: record("authSalt", "252812b3"),
      authenticate: record("authenticate", { accessToken: "t" }),
      balances: record("balances", { balances: [] }),
    } as never,
    funding: {
      prepare: record("prepare", { userOperation: {}, authorization: null, feeCapAtoms: "1" }),
      submit: record("submit", "0x01"),
      receipt: record("receipt", { found: false }),
    } as never,
    fusion: { 4663: fusion(""), 8453: fusion("base:") } as never,
  });
  return app;
}

const quote = {
  dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", recipientType: "CONFIDENTIAL_INTENTS",
  recipient: wallet, refundType: "ORIGIN_CHAIN", refundTo: wallet, originAsset: "a", destinationAsset: "a",
  amount: "1000000", slippageTolerance: 100, confidentiality: "advanced",
};

test("forwards only advanced-confidentiality live quotes", async () => {
  const calls: unknown[][] = [];
  const app = build(calls);
  assert.equal((await app.inject({ method: "POST", url: "/v1/swap/aurora/quote", payload: quote })).statusCode, 200);
  for (const change of [{ confidentiality: "none" }, { dry: true }, { amount: "0" }, { extra: 1 }]) {
    const response = await app.inject({ method: "POST", url: "/v1/swap/aurora/quote", payload: { ...quote, ...change } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.length, 1);
  await app.close();
});

test("normalizes addresses and parses atom amounts before calling adapters", async () => {
  const calls: unknown[][] = [];
  const app = build(calls);
  const prepared = await app.inject({ method: "POST", url: "/v1/swap/monad/prepare-funding", payload: { owner: wallet, recipient: amzn, amount: "9876543" } });
  assert.equal(prepared.statusCode, 200);
  assert.deepEqual(calls[0], ["prepare", "0x8ba1f109551bD432803012645Ac136ddd64DBA72", amzn, 9_876_543n]);
  const intent = await app.inject({ method: "POST", url: "/v1/swap/aurora/generate-intent", payload: { signerId: "0x47DA3495D8886365d454Fa989E76377adaF89391", depositAddress: "d790" } });
  assert.equal(intent.statusCode, 200);
  assert.deepEqual(calls[1], ["generateIntent", "0x47da3495d8886365d454fa989e76377adaf89391", "d790"]);
  await app.close();
});

test("rejects malformed signed payloads", async () => {
  const app = build([]);
  const badIntent = await app.inject({ method: "POST", url: "/v1/swap/aurora/submit-intent", payload: { signedData: { standard: "erc191", payload: "{}", signature: "0xdead" } } });
  assert.equal(badIntent.statusCode, 400);
  const badPermit = await app.inject({ method: "POST", url: "/v1/swap/fusion/order", payload: { wallet, dstToken: amzn, amount: "1", permit: "0x11", preset: "fast" } });
  assert.equal(badPermit.statusCode, 400);
  const badOperation = await app.inject({ method: "POST", url: "/v1/swap/monad/submit", payload: { userOperation: { sender: wallet } } });
  assert.equal(badOperation.statusCode, 400);
  await app.close();
});

test("reports an unknown Fusion order as 404", async () => {
  const app = build([]);
  const response = await app.inject({ method: "POST", url: "/v1/swap/fusion/status", payload: { orderHash: `0x${"ab".repeat(32)}` } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "FUSION_NOT_FOUND");
  await app.close();
});

test("forwards an optional Fusion source token for a reverse sale", async () => {
  const calls: unknown[][] = [];
  const app = build(calls);
  const preview = await app.inject({
    method: "POST",
    url: "/v1/swap/fusion/preview",
    payload: { wallet, dstToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amount: "1", preset: "fast", srcToken: amzn },
  });
  assert.equal(preview.statusCode, 200);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call[0], "preview");
  assert.equal(call[2], "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(call[5], "0x12f190a9F9d7D37a250758b26824B97CE941bF54");
  await app.close();
});

test("forwards the sell receiver and keeps buy receiver optional", async () => {
  const calls: unknown[][] = [];
  const app = build(calls);
  const payload = { wallet, dstToken: amzn, amount: "123", permit: `0x${"11".repeat(224)}`, preset: "fast" };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/order", payload: { ...payload, receiver: wallet, srcToken: amzn } })).statusCode, 200);
    assert.deepEqual(calls[0], ["createOrder", "0x8ba1f109551bD432803012645Ac136ddd64DBA72", amzn, 123n, payload.permit, "fast", amzn, "0x8ba1f109551bD432803012645Ac136ddd64DBA72"]);
    assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/order", payload })).statusCode, 200);
    assert.equal(calls[1]?.[7], undefined);
    assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/order", payload: { ...payload, receiver: "wrong" } })).statusCode, 400);
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});

test("a Base body reaches the Base Fusion adapter, a body without a chain stays on Robinhood", async () => {
  const calls: unknown[][] = [];
  const app = build(calls);
  const base = { wallet, dstToken: amzn, amount: "1000000", preset: "fast" };
  assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/preview", payload: base })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/preview", payload: { ...base, chainId: 8453 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/permit-context", payload: { owner: wallet, chainId: 8453 } })).statusCode, 200);
  const orderHash = `0x${"ab".repeat(32)}`;
  assert.equal((await app.inject({ method: "POST", url: "/v1/swap/fusion/status", payload: { orderHash, chainId: 8453 } })).statusCode, 404);
  assert.deepEqual(calls.map((call) => call[0]), ["preview", "base:preview", "base:permitContext", "base:status"]);
  for (const chainId of [1, 143, "8453", null]) {
    const response = await app.inject({ method: "POST", url: "/v1/swap/fusion/preview", payload: { ...base, chainId } });
    assert.equal(response.statusCode, 400, `chainId ${String(chainId)}`);
  }
  assert.equal(calls.length, 4);
  await app.close();
});
