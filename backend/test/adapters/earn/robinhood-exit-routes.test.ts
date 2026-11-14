import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "@fastify/type-provider-zod";
import { registerEarnPlanningRoutes } from "../../../src/http/routes/earn-planning.routes.ts";
test("withdrawal and return previews are distinct requested actions with strict bodies", async () => {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const calls: unknown[] = [];
  const withdrawal = {
    plan: async (input: any) => {
      calls.push(input);
      return { kind: "hoodRedeemAll" };
    },
  };
  const returns = {
    plan: async (input: any) => {
      calls.push(input);
      return { kind: "hoodTokenReturn" };
    },
  };
  registerEarnPlanningRoutes(
    app,
    undefined,
    undefined,
    undefined,
    undefined,
    withdrawal as any,
    returns as any,
  );
  const input = {
    owner: "0x1000000000000000000000000000000000000001",
    operationId: "exit",
    revision: 1,
  };
  const withdraw = await app.inject({
    method: "POST",
    url: "/v1/earn/robinhood/withdrawal-plan",
    payload: input,
  });
  assert.equal(withdraw.statusCode, 200);
  assert.equal(withdraw.json().kind, "hoodRedeemAll");
  const ret = await app.inject({
    method: "POST",
    url: "/v1/earn/robinhood/return-plan",
    payload: {
      ...input,
      confidentialAccount: "0x2000000000000000000000000000000000000002",
    },
  });
  assert.equal(ret.statusCode, 200);
  assert.equal(ret.json().kind, "hoodTokenReturn");
  assert.equal(ret.headers["cache-control"], "no-store");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/earn/robinhood/return-plan",
        payload: { ...input, amountAtoms: "999999" },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls.length, 2);
  const portion = await app.inject({
    method: "POST",
    url: "/v1/earn/robinhood/withdrawal-plan",
    payload: {
      ...input,
      requestedWithdrawalAtoms: "500000",
      withdrawalRequestId: "request_1",
      confidentialAccount: "0x2000000000000000000000000000000000000002",
    },
  });
  assert.equal(portion.statusCode, 200);
  assert.equal((calls.at(-1) as any).requestedWithdrawalAtoms, "500000");
  const sourced = await app.inject({
    method: "POST",
    url: "/v1/earn/robinhood/return-plan",
    payload: {
      ...input,
      confidentialAccount: "0x2000000000000000000000000000000000000002",
      withdrawalOperationId: "redeem_1",
      returnBudgetAtoms: "500000",
    },
  });
  assert.equal(sourced.statusCode, 200);
  assert.equal((calls.at(-1) as any).withdrawalOperationId, "redeem_1");
  await app.close();
});
