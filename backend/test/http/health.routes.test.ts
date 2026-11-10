import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../../src/app.ts";

test("health reports database unavailable when postgres is unreachable", async () => {
  const app = await buildApp({
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "postgres://private_investment:private_investment@127.0.0.1:1/none",
    ONEINCH_API_KEY: "oneinch-api-key",
    AURORA_API_KEY: "aurora-api-key",
    PIMLICO_API_KEY: "pimlico-api-key",
  });
  const response = await app.inject({
    method: "GET",
    url: "/v1/health",
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    code: "DATABASE_UNAVAILABLE",
    message: "database unavailable",
  });
  await app.close();
});
