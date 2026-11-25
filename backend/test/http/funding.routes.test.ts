import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { validatorCompiler } from "@fastify/type-provider-zod";
import { registerPrivateHttp } from "../../src/http/private-http.ts";
import { registerFundingRoutes } from "../../src/http/routes/funding.routes.ts";

test("funding routes select the source network, bind response identity and reject unknown sources", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  registerPrivateHttp(app);
  const seen: unknown[] = [];
  const gateways = Object.fromEntries(
    [143, 8453, 42161].map((id) => [
      id,
      {
        planner: {
          prepare: async (input: unknown) => {
            seen.push([id, input]);
            return { chainId: id, feeCap: "10" };
          },
        },
        funding: {
          prepare: async () => ({
            authorization: null,
            userOperation: {},
            feeCapAtoms: "10",
          }),
          submit: async () => "0x01",
          receipt: async () => {
            seen.push(id);
            return { found: false };
          },
        },
      },
    ]),
  );
  registerFundingRoutes(app, gateways as never);
  const payload = {
    owner: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amount: "4999990",
    budget: "5000000",
  };
  const reply = await app.inject({
    method: "POST",
    url: "/v1/funding/42161/plan",
    payload,
  });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().sourceChainId, 42161);
  assert.equal(
    reply.json().token.toLowerCase(),
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  );
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.deepEqual(seen, [[42161, payload]]);
  const receipt = await app.inject({
    method: "POST",
    url: "/v1/funding/8453/receipt",
    payload: { userOperationHash: "0x" + "11".repeat(32) },
  });
  assert.equal(receipt.statusCode, 200);
  assert.equal(seen.at(-1), 8453);
  const bad = await app.inject({
    method: "POST",
    url: "/v1/funding/4663/plan",
    payload,
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.includes(payload.owner), false);
  const prepare = await app.inject({
    method: "POST",
    url: "/v1/funding/8453/prepare",
    payload: {
      owner: payload.owner,
      recipient: payload.recipient,
      amount: "4999990",
    },
  });
  assert.equal(prepare.statusCode, 200);
  assert.equal(prepare.json().sourceChainId, 8453);
  await app.close();
});

test("funding submit rejects a signature authorization for a different source chain", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  let sends = 0;
  registerFundingRoutes(app, {
    8453: {
      funding: {
        submit: async () => {
          sends++;
          return "0x01";
        },
      },
    },
  } as never);
  const h = "0x" + "11".repeat(32),
    owner = "0x1111111111111111111111111111111111111111";
  const operation = {
    sender: owner,
    nonce: "0x0",
    callData: "0x12",
    signature: "0x12",
    callGasLimit: "0x1",
    verificationGasLimit: "0x1",
    preVerificationGas: "0x1",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x0",
    paymaster: owner,
    paymasterVerificationGasLimit: "0x1",
    paymasterPostOpGasLimit: "0x1",
    paymasterData: "0x12",
    eip7702Auth: {
      chainId: "0x8f",
      address: owner,
      nonce: "0x0",
      r: h,
      s: h,
      yParity: "0x0",
    },
  };
  const reply = await app.inject({
    method: "POST",
    url: "/v1/funding/8453/submit",
    payload: { userOperation: operation },
  });
  assert.equal(reply.statusCode, 400);
  assert.equal(sends, 0);
  await app.close();
});
