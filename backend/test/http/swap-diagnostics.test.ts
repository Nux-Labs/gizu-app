import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { InfrastructureError } from "../../src/domain/errors/infrastructure-error.ts";
import { mapRequestError } from "../../src/http/map-request-error.ts";

test("swap errors log the code without provider messages or nested causes", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  app.setErrorHandler(mapRequestError);
  app.post("/v1/swap/aurora/quote", async () => {
    throw new InfrastructureError(422, "AURORA_REJECTED", "private-payload", {
      cause: new Error("private-key"),
    });
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/swap/aurora/quote",
      payload: { signedData: "private-signature" },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.includes("private-payload"),false);
    const logs = lines.join("");
    assert.ok(logs.includes("AURORA_REJECTED"));
    assert.ok(logs.includes("swap.error"));
    assert.equal(logs.includes("private-"), false);
  } finally {
    await app.close();
  }
});
