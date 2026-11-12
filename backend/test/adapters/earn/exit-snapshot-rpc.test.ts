import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toHex } from "viem";
import { EarnExitSnapshot } from "../../../src/adapters/earn/exit-snapshot.ts";
import { ROBINHOOD_PROFILE } from "../../../src/adapters/earn/robinhood-vault.ts";
import {
  monadUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
const now = Date.parse("2026-09-30T10:00:00Z"),
  owner = "0x1000000000000000000000000000000000000001",
  hash = "0x" + "11".repeat(32),
  u = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
test("real read-only transport pins every contract/balance read then canonically rechecks after fresh server-held prices", async (t) => {
  const calls: { method: string; params: any[] }[] = [];
  const rpcOrigins = new Set<string>();
  let priceFailure: "http" | "json" | "tls" | "unknown-code" | undefined;
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    if (
      String(url).startsWith(
        "https://intents-api.aurora.dev/api/tokens/server-held-test-key",
      )
    ) {
      if (priceFailure === "http")
        return Response.json(
          { message: "private-provider-response" },
          { status: 503 },
        );
      if (priceFailure === "json")
        return new Response("private-invalid-json", { status: 200 });
      if (priceFailure === "tls" || priceFailure === "unknown-code")
        throw new TypeError("private-keyed-url", {
          cause: Object.assign(new Error("private-certificate-or-host"), {
            code:
              priceFailure === "tls"
                ? "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
                : "private-arbitrary-error-code",
          }),
        });
      return Response.json({
        tokens: [
          {
            assetId: robinhoodUsdgAssetId,
            blockchain: "hood",
            decimals: 6,
            contractAddress: ROBINHOOD_PROFILE.token,
            price: "1",
            priceUpdatedAt: new Date(now).toISOString(),
          },
          {
            assetId: monadUsdcAssetId,
            blockchain: "monad",
            decimals: 6,
            contractAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            price: "1",
            priceUpdatedAt: new Date(now).toISOString(),
          },
        ],
      });
    }
    const origin = new URL(url instanceof Request ? url.url : String(url))
      .origin;
    assert.ok(
      [
        "https://hood-rpc.test",
        "https://rpc.mainnet.chain.robinhood.com",
      ].includes(origin),
    );
    rpcOrigins.add(origin);
    const q = JSON.parse(init?.body ?? (await url.text()));
    calls.push(q);
    let result: unknown;
    if (q.method === "eth_chainId") result = "0x1237";
    else if (q.method === "eth_getBlockByNumber")
      result = { number: "0x64", hash, timestamp: toHex(BigInt(now / 1000)) };
    else if (q.method === "eth_getBalance") result = "0x0";
    else if (q.method === "eth_getCode") result = "0x6000";
    else if (q.method === "eth_call") {
      const { to, data } = q.params[0];
      if (data.startsWith("0x70a08231"))
        result = u(
          to.toLowerCase() === ROBINHOOD_PROFILE.token.toLowerCase()
            ? 100000n
            : 0n,
        );
      else if (data === "0x313ce567")
        result = u(
          to.toLowerCase() === ROBINHOOD_PROFILE.token.toLowerCase() ? 6n : 18n,
        );
      else if (data === "0x38d52e0f")
        result = encodeAbiParameters(
          [{ type: "address" }],
          [ROBINHOOD_PROFILE.token],
        );
      else assert.fail("Unknown contract selector");
    } else assert.fail("Unexpected RPC method");
    return Response.json({ jsonrpc: "2.0", id: q.id, result });
  });
  const p = await new EarnExitSnapshot(
    {
      robinhoodRpcUrl: "https://hood-rpc.test",
      auroraApiKey: "server-held-test-key",
    },
    undefined,
    () => now,
  ).read({ profileId: "robinhood-usdg", owner });
  assert.equal(p.residualUsdcAtoms, "100000");
  assert.equal(p.prices.ethUsd18, null);
  const reads = calls.filter((q) =>
    ["eth_call", "eth_getBalance", "eth_getCode"].includes(q.method),
  );
  assert.equal(reads.length, 11);
  assert.ok(reads.every((q) => q.params[1] === "0x64"));
  assert.deepEqual(
    calls
      .filter((q) => q.method === "eth_getBlockByNumber")
      .map((q) => q.params),
    [
      ["latest", false],
      ["0x64", false],
    ],
  );
  assert.ok(
    calls.every(
      (q) => !q.method.includes("send") && !q.method.includes("sign"),
    ),
  );
  const defaultRpc = await new EarnExitSnapshot(
    { auroraApiKey: "server-held-test-key" },
    undefined,
    () => now,
  ).read({ profileId: "robinhood-usdg", owner });
  assert.equal(defaultRpc.residualUsdcAtoms, "100000");
  assert.ok(rpcOrigins.has("https://rpc.mainnet.chain.robinhood.com"));
  for (const [failure, want] of [
    [
      "http",
      { stage: "prices-fetch", reason: "provider-http", httpStatus: 503 },
    ],
    [
      "json",
      {
        stage: "prices-fetch",
        reason: "provider-response-json",
        httpStatus: 200,
        errorType: "SyntaxError",
      },
    ],
    [
      "tls",
      {
        stage: "prices-fetch",
        reason: "unclassified",
        errorType: "TypeError",
        transportCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
    ],
    [
      "unknown-code",
      { stage: "prices-fetch", reason: "unclassified", errorType: "TypeError" },
    ],
  ] as const) {
    priceFailure = failure;
    await assert.rejects(
      new EarnExitSnapshot(
        {
          robinhoodRpcUrl: "https://hood-rpc.test",
          auroraApiKey: "server-held-test-key",
        },
        undefined,
        () => now,
      ).read({ profileId: "robinhood-usdg", owner }),
      (error: any) => {
        assert.deepEqual(error.diagnostic, want);
        assert.ok(!JSON.stringify(error).includes("private-"));
        assert.ok(!JSON.stringify(error).includes("server-held-test-key"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});
