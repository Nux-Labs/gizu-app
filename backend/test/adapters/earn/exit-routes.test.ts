import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  validatorCompiler,
  serializerCompiler,
} from "@fastify/type-provider-zod";
import { registerEarnExitRoutes } from "../../../src/http/routes/earn-exit.routes.ts";
import { EarnExitSnapshot } from "../../../src/adapters/earn/exit-snapshot.ts";
import { mapRequestError } from "../../../src/http/map-request-error.ts";
test("exit reads only explicitly requested investment owner and rejects linked identities", async () => {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const calls: unknown[] = [];
  registerEarnExitRoutes(app, {
    read: async (input) => {
      calls.push(input);
      return { readOnly: true } as any;
    },
  });
  const body = {
    profileId: "robinhood-usdg",
    owner: "0x1000000000000000000000000000000000000001",
  };
  const r = await app.inject({
    method: "POST",
    url: "/v1/earn/exit-snapshot",
    payload: body,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  for (const patch of [
    { confidentialAccount: body.owner },
    { holdOwner: body.owner },
    { rpcUrl: "https://evil.test" },
    { profileId: "monad" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/earn/exit-snapshot",
          payload: { ...body, ...patch },
        })
      ).statusCode,
      400,
    );
  assert.deepEqual(calls, [body]);
  await app.close();
});

test("exit failure logs correlate safe diagnostics to the request without changing the private response", async () => {
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
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  registerEarnExitRoutes(
    app,
    new EarnExitSnapshot(
      {},
      {
        read: async () => {
          throw new TypeError("private-rpc-url-key-and-owner", {
            cause: Object.assign(new Error("private-host"), {
              code: "ECONNRESET",
            }),
          });
        },
        prices: async () => {
          throw Error("must-not-reach-prices");
        },
        canonical: async () => {},
      },
    ),
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/exit-snapshot",
      payload: {
        profileId: "robinhood-usdg",
        owner: "0x1000000000000000000000000000000000000001",
      },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_ERROR",
      message: "The private request could not be completed.",
    });
    const failure = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "private.error");
    assert.ok(failure.reqId);
    assert.equal(failure.route, "/v1/earn/exit-snapshot");
    assert.deepEqual(failure.exitSnapshot, {
      stage: "chain-read",
      reason: "unclassified",
      errorType: "TypeError",
      transportCode: "ECONNRESET",
    });
    assert.ok(!lines.join("").includes("private-rpc"));
    assert.ok(
      !lines.join("").includes("0x1000000000000000000000000000000000000001"),
    );
    assert.ok(!response.body.includes("ECONNRESET"));
  } finally {
    await app.close();
  }
});
