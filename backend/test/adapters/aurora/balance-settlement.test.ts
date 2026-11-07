import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  validatorCompiler,
  serializerCompiler,
} from "@fastify/type-provider-zod";
import { registerEarnSettlementRoutes } from "../../../src/http/routes/earn-settlement.routes.ts";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes } from "viem";
import { base58 } from "@scure/base";
import { ConfidentialSettlement } from "../../../src/adapters/aurora/settlement.ts";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
const now = Date.parse("2026-10-12T10:00:00Z"),
  key = "11".repeat(32),
  account = privateKeyToAccount(("0x" + "1".repeat(64)) as `0x${string}`);
const C = account.address.toLowerCase(),
  owner = "0x" + "2".repeat(40),
  deposit = "0x" + "3".repeat(40),
  tx = "0x" + "a".repeat(64);
async function auth() {
  const nonce = Buffer.alloc(32);
  Buffer.from("5628f6c600", "hex").copy(nonce);
  nonce.writeBigUInt64LE(BigInt(now + 300000) * 1000000n, 9);
  nonce.writeBigUInt64LE(BigInt(now) * 1000000n, 17);
  const payload = JSON.stringify({
    deadline: new Date(now + 300000).toISOString(),
    intents: [],
    nonce: nonce.toString("base64"),
    signer_id: C,
    verifying_contract: "intents.near",
  });
  const bytes = hexToBytes(await account.signMessage({ message: payload }));
  bytes[64]! -= 27;
  return {
    standard: "erc191" as const,
    payload,
    signature: "secp256k1:" + base58.encode(bytes),
  };
}
function setup(
  originAsset = monadUsdcAssetId,
  diagnose?: (event: unknown) => void,
) {
  let balance = "100",
    status = "SUCCESS";
  let clock = now,
    historyLatency = 0;
  let historyStatus = 200;
  let history: Record<string, unknown>[] | undefined;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes("history")) {
      if (!history) throw Error("History is unavailable");
      clock += historyLatency;
      if (historyStatus !== 200)
        return new Response(
          JSON.stringify({ message: "PRIVATE-PROVIDER-TEXT " + C }),
          { status: historyStatus },
        );
      return new Response(JSON.stringify({ items: history }));
    }
    return new Response(
      JSON.stringify(
        path.includes("authenticate")
          ? { accessToken: "jwt" }
          : path.includes("/status/")
            ? { status }
            : path.includes("/account/balances/")
              ? {
                  balances: [
                    {
                      source: "private",
                      tokenId: monadUsdcAssetId,
                      available: balance,
                    },
                  ],
                }
              : {
                  tokens: [
                    {
                      assetId: monadUsdcAssetId,
                      blockchain: "monad",
                      symbol: "USDC",
                      decimals: 6,
                      contractAddress:
                        "0x754704bc059f8c67012fed69bc8a327a5aafb603",
                    },
                  ],
                },
      ),
    );
  };
  const service = () =>
    new ConfidentialSettlement("api-key", fetcher, () => clock, key, diagnose);
  const quote = {
    operationId: "fund_1",
    revision: 1,
    recipient: deposit,
    confidentialAccount: C,
    refundOwner: owner,
    originAsset,
    destinationAsset: monadUsdcAssetId,
    amountAtoms: "1000000",
    minimumCreditAtoms: "990000",
    maximumCreditAtoms: "995000",
    quoteCreatedAt: now / 1000,
    expiresAt: now / 1000 + 600,
  };
  const quoteEnvelope = new EarnRecoveryEnvelope(key).seal("native-quote", {
    quote,
    settlement: quote,
  });
  const expected = {
    operationId: "fund_1",
    revision: 2,
    depositAddress: deposit,
    sourceOwner: owner,
    confidentialAccount: C,
    originAsset,
    amountAtoms: "1000000",
    minimumCreditAtoms: "990000",
    transactionHash: tx,
    quoteEnvelope,
  };
  return {
    service,
    expected,
    calls,
    setHistoryLatency: (ms: number) => {
      historyLatency = ms;
    },
    setHistoryStatus: (status: number) => {
      historyStatus = status;
    },
    setHistory: (rows: Record<string, unknown>[]) => {
      history = rows;
    },
    setBalance: (v: string) => {
      balance = v;
    },
    setStatus: (v: string) => {
      status = v;
    },
  };
}
test("new settlement uses exact route and authenticated balance delta; portable credit survives consumption and restart", async () => {
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  f.setBalance("995100");
  const expected = {
    ...f.expected,
    baselineEnvelope: baseline.baselineEnvelope,
  };
  const proof = await f.service().read(signed, expected);
  assert.equal(proof.creditedAtoms, "995000");
  assert.equal(proof.status, "credited");
  assert.ok("settlementEnvelope" in proof);
  if (!("settlementEnvelope" in proof))
    throw Error("Missing credit attestation");
  f.setBalance("0");
  const restored = await f.service().read(signed, {
    ...expected,
    settlementEnvelope: proof.settlementEnvelope,
  });
  assert.equal(restored.creditedAtoms, "995000");
  assert.ok(!f.calls.some((p) => p.includes("history")));
  await assert.rejects(
    f.service().read(signed, {
      ...expected,
      sourceOwner: deposit,
      settlementEnvelope: proof.settlementEnvelope,
    }),
  );
  await assert.rejects(
    f.service().read(signed, {
      ...expected,
      baselineEnvelope: baseline.baselineEnvelope + "a",
    }),
  );
});

test("history diagnostics distinguish provider access, origin-owner and credit mismatches without retaining private data", async () => {
  for (const variant of ["access", "owner", "credit"] as const) {
    const events: unknown[] = [];
    const f = setup(monadUsdcAssetId, (event) => events.push(event));
    const signed = await auth(),
      baseline = await f.service().baseline(signed);
    f.setBalance("995101");
    f.setHistory([
      {
        ...exactHistory(),
        ...(variant === "owner"
          ? { quoteTransactions: [{ sender: deposit, txHash: tx }] }
          : {}),
        ...(variant === "credit" ? { amountOutFormatted: "0.995" } : {}),
      },
    ]);
    if (variant === "access") f.setHistoryStatus(403);
    await assert.rejects(
      f
        .service()
        .read(
          signed,
          { ...f.expected, baselineEnvelope: baseline.baselineEnvelope },
          true,
        ),
    );
    const history = events.filter(
      (event: any) => event.event === "earn.settlement-history",
    );
    assert.deepEqual(history, [
      {
        event: "earn.settlement-history",
        stage:
          variant === "access"
            ? "history"
            : variant === "owner"
              ? "origin"
              : "credit",
        httpStatus: variant === "access" ? 403 : 200,
        reason:
          variant === "access"
            ? "provider"
            : variant === "owner"
              ? "origin-owner"
              : "balance-delta",
      },
    ]);
    const logged = JSON.stringify(history);
    for (const secret of [
      C,
      owner,
      deposit,
      tx,
      "PRIVATE-PROVIDER-TEXT",
      "995101",
      "995000",
      "api-key",
      "jwt",
      signed.signature,
    ])
      assert.equal(logged.includes(secret), false);
  }
});

function exactHistory(originAsset = monadUsdcAssetId): Record<string, unknown> {
  return {
    status: "SUCCESS",
    depositType: "ORIGIN_CHAIN",
    recipientType: "CONFIDENTIAL_INTENTS",
    refundType: "ORIGIN_CHAIN",
    createdAt: new Date(now - 10000).toISOString(),
    depositAddress: deposit,
    originAsset,
    destinationAsset: monadUsdcAssetId,
    recipient: C,
    refundTo: owner,
    amountInFormatted:
      originAsset === "nep141:eth.omft.near" ? "0.000000000001" : "1",
    amountOutFormatted: "0.995001",
    quoteTransactions: [{ sender: owner, txHash: tx }],
  };
}

test("better execution requires exact authenticated route history and survives consumed-balance replay", async () => {
  for (const origin of [
    monadUsdcAssetId,
    ethereumUsdcAssetId,
    robinhoodUsdgAssetId,
    "nep141:eth.omft.near",
  ]) {
    const f = setup(origin),
      signed = await auth(),
      baseline = await f.service().baseline(signed);
    const expected = {
      ...f.expected,
      maximumCreditAtoms: "995000",
      baselineEnvelope: baseline.baselineEnvelope,
    };
    f.setBalance("995101");
    f.setHistory([exactHistory(origin)]);
    const proof = await f.service().read(signed, expected, true);
    assert.equal(proof.status, "credited");
    assert.equal(proof.creditedAtoms, "995001");
    assert.ok("verification" in proof && "settlementEnvelope" in proof);
    assert.equal(proof.verification, "operation-history-v1");
    assert.ok(proof.settlementEnvelope);
    f.setBalance("0");
    f.setHistory([]);
    const restored = await f.service().read(
      signed,
      {
        ...expected,
        revision: 3,
        settlementEnvelope: proof.settlementEnvelope,
      },
      true,
    );
    assert.equal(restored.creditedAtoms, "995001");
    assert.ok("verification" in restored);
    assert.equal(restored.verification, "operation-history-v1");
    assert.equal(restored.revision, 3);
    await assert.rejects(
      f.service().read(signed, {
        ...expected,
        settlementEnvelope: proof.settlementEnvelope,
      }),
    );
  }
});

test("extra private balance cannot bypass missing, mismatched or ambiguous operation history", async () => {
  for (const rows of [
    [],
    [{ ...exactHistory(), amountOutFormatted: "0.995" }],
    [{ ...exactHistory(), recipient: owner }],
    [{ ...exactHistory(), refundTo: deposit }],
    [{ ...exactHistory(), originAsset: "wrong" }],
    [{ ...exactHistory(), destinationAsset: "wrong" }],
    [{ ...exactHistory(), amountInFormatted: "2" }],
    [
      {
        ...exactHistory(),
        quoteTransactions: [{ sender: owner, txHash: "0x" + "b".repeat(64) }],
      },
    ],
    [
      {
        ...exactHistory(),
        quoteTransactions: [{ sender: deposit, txHash: tx }],
      },
    ],
    [exactHistory(), exactHistory()],
  ]) {
    const f = setup(),
      signed = await auth(),
      baseline = await f.service().baseline(signed);
    f.setBalance("995101");
    f.setHistory(rows);
    await assert.rejects(
      f
        .service()
        .read(
          signed,
          { ...f.expected, baselineEnvelope: baseline.baselineEnvelope },
          true,
        ),
    );
  }
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  f.setBalance("995101");
  await assert.rejects(
    f
      .service()
      .read(
        signed,
        { ...f.expected, baselineEnvelope: baseline.baselineEnvelope },
        true,
      ),
  );
});

test("the settlement endpoint negotiates history proofs without changing saved request bodies", async () => {
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  f.setBalance("995101");
  f.setHistory([exactHistory()]);
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerEarnSettlementRoutes(app, f.service());
  const payload = {
    signedData: signed,
    expected: { ...f.expected, baselineEnvelope: baseline.baselineEnvelope },
  };
  try {
    const legacy = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement",
      payload,
    });
    assert.equal(legacy.statusCode, 502);
    assert.equal(
      f.calls.some((path) => path.includes("history")),
      false,
    );
    const modern = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement",
      payload,
      headers: { "x-gizu-settlement-proof": "operation-history-v1" },
    });
    assert.equal(modern.statusCode, 200);
    assert.equal(modern.json().verification, "operation-history-v1");
    assert.equal(modern.json().creditedAtoms, "995001");
    assert.equal(modern.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});

test("history attestation is issued after verification and cannot refresh stale balance evidence", async () => {
  const signed = await auth();
  const f = setup(),
    baseline = await f.service().baseline(signed);
  f.setBalance("995101");
  f.setHistory([exactHistory()]);
  f.setHistoryLatency(20000);
  const proof = await f
    .service()
    .read(
      signed,
      { ...f.expected, baselineEnvelope: baseline.baselineEnvelope },
      true,
    );
  assert.equal(proof.timestampMs, now + 20000);
  const stale = setup(),
    oldBaseline = await stale.service().baseline(signed);
  stale.setBalance("995101");
  stale.setHistory([exactHistory()]);
  stale.setHistoryLatency(60001);
  await assert.rejects(
    stale
      .service()
      .read(
        signed,
        { ...stale.expected, baselineEnvelope: oldBaseline.baselineEnvelope },
        true,
      ),
  );
});
test("pending, missing, reduced and excess balances never become source credit", async () => {
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed),
    expected = { ...f.expected, baselineEnvelope: baseline.baselineEnvelope };
  f.setStatus("PROCESSING");
  f.setBalance("995100");
  assert.equal((await f.service().read(signed, expected)).creditedAtoms, "0");
  f.setStatus("SUCCESS");
  f.setBalance("100");
  assert.equal(
    (await f.service().read(signed, expected)).status,
    "awaitingSettlement",
  );
  f.setBalance("99");
  await assert.rejects(f.service().read(signed, expected));
  f.setBalance("995101");
  await assert.rejects(f.service().read(signed, expected));
});

test("wrong-owner snapshots, mismatched saved quotes and manufactured late baselines cannot qualify credit", async () => {
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  f.setBalance("995100");
  const expected = {
    ...f.expected,
    baselineEnvelope: baseline.baselineEnvelope,
  };
  for (const patch of [
    { transactionHash: "bad" },
    { depositAddress: owner },
    { amountAtoms: "1000001" },
    { minimumCreditAtoms: "990001" },
    { maximumCreditAtoms: "995001" },
    { confidentialAccount: owner },
  ])
    await assert.rejects(f.service().read(signed, { ...expected, ...patch }));
  const envelope = new EarnRecoveryEnvelope(key);
  const wrong = envelope.seal("private-balance", {
    ...baseline,
    confidentialAddress: owner,
  });
  await assert.rejects(
    f.service().read(signed, { ...expected, baselineEnvelope: wrong }),
  );
  const late = envelope.seal("private-balance", {
    ...baseline,
    timestampMs: now + 601000,
  });
  await assert.rejects(
    f.service().read(signed, { ...expected, baselineEnvelope: late }),
  );
});

test("settlement checks log only route status, balance entry kinds and credit class", async () => {
  const f = setup(),
    signed = await auth(),
    baseline = await f.service().baseline(signed),
    expected = { ...f.expected, baselineEnvelope: baseline.baselineEnvelope };
  const wrapped = "imt:" + "ab".repeat(32) + ":" + monadUsdcAssetId;
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    const body = path.includes("authenticate")
      ? { accessToken: "jwt" }
      : path.includes("/status/")
        ? { status: "SUCCESS" }
        : path.includes("/account/balances/")
          ? {
              balances: path.includes("tokenIds=")
                ? [
                    {
                      source: "private",
                      tokenId: monadUsdcAssetId,
                      available: "100",
                    },
                  ]
                : [
                    {
                      source: "private",
                      tokenId: monadUsdcAssetId,
                      available: "100",
                    },
                    {
                      source: "public",
                      tokenId: monadUsdcAssetId,
                      available: "995000",
                    },
                    {
                      source: "private",
                      tokenId: wrapped,
                      available: "995000",
                    },
                  ],
            }
          : {
              tokens: [
                {
                  assetId: monadUsdcAssetId,
                  blockchain: "monad",
                  symbol: "USDC",
                  decimals: 6,
                  contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
                },
              ],
            };
    return new Response(JSON.stringify(body));
  };
  const events: unknown[] = [];
  const proof = await new ConfidentialSettlement(
    "api-key",
    fetcher,
    () => now,
    key,
    (e) => events.push(e),
  ).read(signed, expected);
  assert.equal(proof.status, "awaitingSettlement");
  assert.deepEqual(events, [
    {
      event: "earn.settlement",
      route: "SUCCESS",
      credit: "zero",
      entries: ["private:asset", "public:asset", "private:wrapped"],
      entryFields: ["available", "source", "tokenId"],
      availableZero: false,
      baselineZero: false,
      baselineAtMs: now,
    },
  ]);
  for (const secret of ["995000", "100", C, deposit, tx, "jwt", "api-key"])
    assert.ok(!JSON.stringify(events).includes(secret));
});
