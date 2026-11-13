import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { mapRequestError } from "../../src/http/map-request-error.ts";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
import { RobinhoodPlanFailure } from "../../src/adapters/earn/robinhood-plan-error.ts";
import * as implementation from "../../src/http/private-http.ts";
test("all private request paths use safe allowlisted logging and errors before and after validation", async () => {
  assert.ok(implementation, "safe private HTTP configuration must exist");
  const lines: string[] = [];
  const app = Fastify({
    ...implementation.privateHttpOptions,
    logger: { stream: { write: (line: string) => lines.push(line) } },
  });
  implementation.registerPrivateHttp(app);
  app.setErrorHandler(mapRequestError);
  app.post("/v1/earn/test/:address", async () => {
    throw new InfrastructureError(
      502,
      "PROVIDER_FAILED",
      "sensitive-provider-message",
      { cause: new Error("sensitive-secret") },
    );
  });
  app.get("/wallet-recovery/v1/:id", async () => ({ ok: true }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/test/sensitive-address?bearer=sensitive-query",
      headers: { authorization: "Bearer sensitive-auth" },
      payload: { signature: "sensitive-signature" },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.includes("sensitive-"), false);
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/earn/test/sensitive-address",
      headers: { "content-type": "application/json" },
      payload: "{sensitive-body",
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.headers["cache-control"], "no-store");
    await app.inject(
      "/wallet-recovery/v1/sensitive-opaque-id?token=sensitive-query",
    );
    const logged = lines.join("");
    assert.equal(logged.includes("sensitive-"), false);
    assert.ok(logged.includes("/v1/earn/test/:address"));
    assert.ok(logged.includes("PROVIDER_FAILED"));
  } finally {
    await app.close();
  }
});

test("private plan failures log the safe failing stage while keeping diagnostic details out of responses", async () => {
  const lines: string[] = [];
  const app = Fastify({
    ...implementation.privateHttpOptions,
    logger: { stream: { write: (line: string) => lines.push(line) } },
  });
  implementation.registerPrivateHttp(app);
  app.setErrorHandler(mapRequestError);
  app.post("/v1/earn/robinhood/deposit-plan", async () => {
    throw new RobinhoodPlanFailure(
      "vault-simulation",
      new Error("Changed USDG funded state"),
    );
  });
  app.post("/v1/earn/untrusted-diagnostic", async () => {
    throw Object.assign(
      new InfrastructureError(502, "OTHER_FAILURE", "sensitive-error"),
      {
        diagnostic: {
          stage: "sensitive-stage",
          httpStatus: "sensitive-status",
        },
      },
    );
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/robinhood/deposit-plan",
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      code: "EARN_ROBINHOOD_PLAN_UNAVAILABLE",
      message: "The private request could not be completed.",
    });
    await app.inject({ method: "POST", url: "/v1/earn/untrusted-diagnostic" });
    const errors = lines
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "private.error");
    assert.deepEqual(errors[0].planning, {
      stage: "vault-simulation",
      reason: "funded-state",
    });
    assert.equal(errors[1].planning, undefined);
    assert.equal(lines.join("").includes("sensitive-"), false);
  } finally {
    await app.close();
  }
});

import { GasPolicyError } from "../../src/adapters/evm/gas-errors.ts";
test("private gas errors preserve only the safe deterministic code and retry policy", async () => {
  const app = Fastify(implementation.privateHttpOptions);
  implementation.registerPrivateHttp(app);
  app.setErrorHandler(mapRequestError);
  app.post("/v1/swap/gas-test", async () => {
    throw new GasPolicyError(
      "GAS_APPROVAL_UNSTABLE",
      "sensitive-provider-message",
    );
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/swap/gas-test",
    });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), {
      code: "GAS_APPROVAL_UNSTABLE",
      message: "The private request could not be completed.",
      retryable: false,
    });
  } finally {
    await app.close();
  }
});

test("silent private settlement routes still log a sanitized verification failure code", async () => {
  const lines: string[] = [];
  const app = Fastify({
    ...implementation.privateHttpOptions,
    logger: { stream: { write: (line: string) => lines.push(line) } },
  });
  implementation.registerPrivateHttp(app);
  app.setErrorHandler(mapRequestError);
  app.post("/v1/earn/native/settlement", { logLevel: "silent" }, async () => {
    throw new InfrastructureError(
      503,
      "EARN_MINIMUM_RETURN_HISTORY_UNAVAILABLE",
      "secret-provider-sentinel",
    );
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement",
      payload: { signature: "secret-signature-sentinel" },
    });
    assert.equal(response.statusCode, 503);
    const errors = lines
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "private.error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "EARN_MINIMUM_RETURN_HISTORY_UNAVAILABLE");
    assert.equal(errors[0].route, "/v1/earn/native/settlement");
    assert.equal(typeof errors[0].reqId, "string");
    assert.equal(lines.join("").includes("secret-"), false);
  } finally {
    await app.close();
  }
});
