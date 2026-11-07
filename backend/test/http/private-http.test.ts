import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { mapRequestError } from "../../src/http/map-request-error.ts";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
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

import { GasPolicyError } from "../../src/adapters/evm/gas-errors.ts";
test("private gas errors preserve only the safe deterministic code and retry policy",async()=>{
 const app=Fastify(implementation.privateHttpOptions);implementation.registerPrivateHttp(app);app.setErrorHandler(mapRequestError);
 app.post("/v1/swap/gas-test",async()=>{throw new GasPolicyError("GAS_APPROVAL_UNSTABLE","sensitive-provider-message");});
 try{const response=await app.inject({method:"POST",url:"/v1/swap/gas-test"});assert.equal(response.statusCode,422);assert.deepEqual(response.json(),{code:"GAS_APPROVAL_UNSTABLE",message:"The private request could not be completed.",retryable:false});}
 finally{await app.close();}
});
