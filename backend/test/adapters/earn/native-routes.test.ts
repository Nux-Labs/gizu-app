import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerEarnNativeRoutes } from "../../../src/http/routes/earn-native.routes.ts";
import { NativeEarnGateway } from "../../../src/adapters/earn/native-gateway.ts";

test("disabled origins reject only fresh source quotes and preserve saved bindings and returns", async () => {
  const app = Fastify();
  const seen: string[] = [];
  const gateway = {
    sourceQuote: async () => {
      seen.push("source");
      return {};
    },
    sourcePreview: async () => {
      seen.push("preview");
      return {};
    },
    returnQuote: async () => {
      seen.push("return");
      return {};
    },
    quoteBinding: () => {
      seen.push("binding");
      return {};
    },
  };
  registerEarnNativeRoutes(app, gateway as unknown as NativeEarnGateway);
  for (const route of ["source-quote", "source-preview"]) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/earn/native/${route}`,
      payload: { sourceChainId: 8453 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "FUNDING_CHAIN_DISABLED");
  }
  for (const route of ["quote-binding", "return-quote"])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/earn/native/${route}`,
          payload: { sourceChainId: 8453 },
        })
      ).statusCode,
      200,
    );
  assert.deepEqual(seen, ["binding", "return"]);
  await app.close();
});
for (const chain of [8453, 42161]) {
  test(`native bundler dispatch preserves funding source ${chain}`, async () => {
    const app = Fastify({ logger: false });
    registerEarnNativeRoutes(
      app,
      new NativeEarnGateway(
        { pimlicoApiKey: "server-only" },
        {
          fetcher: async (url) => {
            assert.ok(String(url).includes(`/v2/${chain}/rpc`));
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: ["0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"],
              }),
            );
          },
        },
      ),
    );
    const reply = await app.inject({
      method: "POST",
      url: `/v1/earn/native/bundler/${chain}`,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_supportedEntryPoints",
        params: [],
      },
    });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.json().result, [
      "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    ]);
    await app.close();
  });
}
test("native routes reject unknown methods and paths, no provider keys or request echoes", async () => {
  const app = Fastify({ logger: false });
  registerEarnNativeRoutes(
    app,
    new NativeEarnGateway(
      { pimlicoApiKey: "server-secret" },
      {
        fetcher: async () => {
          throw new Error("server-secret");
        },
      },
    ),
  );
  const response = await app.inject({
    method: "POST",
    url: "/v1/earn/native/bundler/143",
    payload: { jsonrpc: "2.0", id: 1, method: "eth_sign", params: [] },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.includes("eth_sign"), false);
  assert.equal(response.body.includes("server-secret"), false);
  const unavailable = await app.inject({
    method: "POST",
    url: "/v1/earn/native/bundler/143",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_supportedEntryPoints",
      params: [],
    },
  });
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.body.includes("server-secret"), false);
  assert.equal(unavailable.headers["cache-control"], "no-store");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/earn/native/bundler/1",
        payload: {},
      })
    ).statusCode,
    400,
  );
  await app.close();
});
test("native quote routes fail closed without configured fee qualification", async () => {
  const app = Fastify({ logger: false });
  registerEarnNativeRoutes(app, new NativeEarnGateway({}));
  const response = await app.inject({
    method: "POST",
    url: "/v1/earn/native/source-quote",
    payload: {
      operationId: "op",
      revision: 1,
      profileChainId: 1,
      sourceOwner: "0x1000000000000000000000000000000000000001",
      confidentialAccount: "0x2000000000000000000000000000000000000002",
      amountAtoms: "1",
    },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "EARN_AURORA_FEE_UNQUALIFIED");
  assert.equal(response.body.includes("sourceOwner"), false);
  await app.close();
});
test("malformed native JSON and oversized payloads have sanitized route errors", async () => {
  const app = Fastify({ logger: false });
  registerEarnNativeRoutes(app, new NativeEarnGateway({}));
  const broken = await app.inject({
    method: "POST",
    url: "/v1/earn/native/source-quote",
    headers: { "content-type": "application/json" },
    payload: '{"sourceOwner":"secret-wallet",invalid',
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().code, "INVALID_NATIVE_REQUEST");
  assert.equal(broken.body.includes("secret-wallet"), false);
  assert.equal(broken.body.includes("invalid"), false);
  const large = await app.inject({
    method: "POST",
    url: "/v1/earn/native/source-quote",
    payload: { secret: "s".repeat(3000) },
  });
  assert.equal(large.statusCode, 413);
  await app.close();
});
