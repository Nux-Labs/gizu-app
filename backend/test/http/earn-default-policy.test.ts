import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.ts";
import { parseApiEnv } from "../../src/env.schema.ts";

test("Render-style configuration admits known source preview fees without fee JSON or history invitation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.dry, true);
    return Response.json({
      timestamp: new Date().toISOString(),
      quoteRequest: {
        ...request,
        appFees: [{ recipient: "widget_collect.sputnik-dao.near", fee: 4 }],
        referral: "aurora-1u3j2qzclc",
      },
      quote: {
        amountIn: request.amount,
        minAmountIn: request.amount,
        amountOut: "2998800",
        minAmountOut: "2998800",
      },
    });
  };
  const env = parseApiEnv({
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ONEINCH_API_KEY: "test",
    AURORA_API_KEY: "test",
    PIMLICO_API_KEY: "test",
    EARN_GATEWAY_RECOVERY_KEY: "11".repeat(32),
    EARN_AURORA_HISTORY_QUALIFIED: "false",
  });
  const app = await buildApp(env);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/native/source-preview",
      payload: {
        operationId: "preview-test",
        revision: 1,
        profileChainId: 4663,
        sourceOwner: "0x" + "1".repeat(40),
        confidentialAccount: "0x" + "2".repeat(40),
        amountAtoms: "3000000",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().blockers, []);
    assert.equal(response.json().minimumCreditAtoms, "2998800");
  } finally {
    await app.close();
    globalThis.fetch = original;
  }
});
