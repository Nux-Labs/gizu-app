import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  validatorCompiler,
  serializerCompiler,
} from "@fastify/type-provider-zod";
import { registerEarnSettlementRoutes } from "../../../src/http/routes/earn-settlement.routes.ts";
import { ConfidentialSettlement } from "../../../src/adapters/aurora/settlement.ts";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes } from "viem";
import { base58 } from "@scure/base";
import { MinimumReturnVerifier } from "../../../src/adapters/aurora/minimum-return.ts";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
import type {
  MinimumReturnStore,
  MinimumReturnReceipt,
} from "../../../src/ports/minimum-return.port.ts";

// A missing durable sequence comparison must fail the overlap tests.
class MemoryStore implements MinimumReturnStore {
  sequences = new Map<string, string>();
  receipts = new Map<string, MinimumReturnReceipt>();
  async sequence(key: string) {
    return this.sequences.get(key) ?? "0";
  }
  async receipt(key: string) {
    return this.receipts.get(key);
  }
  async finish(value: MinimumReturnReceipt) {
    const old = this.receipts.get(value.routeKey);
    if (old)
      return old.accountKey === value.accountKey &&
        old.commitment === value.commitment
        ? old
        : undefined;
    if ((this.sequences.get(value.accountKey) ?? "0") !== value.sequence)
      return undefined;
    this.receipts.set(value.routeKey, { ...value });
    this.sequences.set(
      value.accountKey,
      (BigInt(value.sequence) + 1n).toString(),
    );
    return { ...value };
  }
}
const now = Date.parse("2026-11-09T10:00:00Z"),
  key = "11".repeat(32);
const account = privateKeyToAccount(("0x" + "1".repeat(64)) as `0x${string}`);
const C = account.address.toLowerCase(),
  owner = "0x" + "2".repeat(40),
  deposit = "0x" + "3".repeat(40),
  tx = "0x" + "a".repeat(64);
async function auth(clock = now) {
  const nonce = Buffer.alloc(32);
  Buffer.from("5628f6c600", "hex").copy(nonce);
  nonce.writeBigUInt64LE(BigInt(clock + 300000) * 1000000n, 9);
  nonce.writeBigUInt64LE(BigInt(clock) * 1000000n, 17);
  const payload = JSON.stringify({
    deadline: new Date(clock + 300000).toISOString(),
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
function fixture(originAsset = robinhoodUsdgAssetId) {
  const store = new MemoryStore(),
    envelopes = new EarnRecoveryEnvelope(key),
    calls: string[] = [];
  let balance = "100",
    clock = now,
    status = "SUCCESS",
    originValid = true,
    balanceHook: (() => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes("history")) throw Error("History must never be used");
    if (path.includes("/account/balances/") && balanceHook) await balanceHook();
    const body = path.includes("authenticate")
      ? { accessToken: "PRIVATE-JWT" }
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
                  contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
                },
              ],
            };
    return new Response(JSON.stringify(body));
  };
  let confirmations = 0;
  const origin = {
    async confirm() {
      confirmations++;
      if (!originValid) throw Error("PRIVATE-RPC-URL");
    },
  };
  const service = (
    overrides: ConstructorParameters<typeof MinimumReturnVerifier>[0] = {},
  ) =>
    new MinimumReturnVerifier({
      key: "PRIVATE-API-KEY",
      recoveryKey: key,
      store,
      origin,
      fetcher,
      now: () => clock,
      ...overrides,
    });
  const quote = {
    operationId: "return_1",
    revision: 1,
    chainId: originAsset === robinhoodUsdgAssetId ? 4663 : 1,
    token:
      originAsset === robinhoodUsdgAssetId
        ? "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
        : originAsset === ethereumUsdcAssetId
          ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
          : "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    recipient: deposit,
    refundOwner: owner,
    confidentialAccount: C,
    originAsset,
    destinationAsset: monadUsdcAssetId,
    amountAtoms: "1000000",
    minimumCreditAtoms: "990000",
    maximumCreditAtoms: "995000",
    quoteCreatedAt: now / 1000,
    expiresAt: now / 1000 + 600,
  };
  const expected = {
    operationId: quote.operationId,
    revision: 2,
    depositAddress: deposit,
    sourceOwner: owner,
    confidentialAccount: C,
    originAsset,
    amountAtoms: quote.amountAtoms,
    minimumCreditAtoms: quote.minimumCreditAtoms,
    transactionHash: tx,
    quoteEnvelope: envelopes.seal("native-quote", { quote, settlement: quote }),
  };
  return {
    service,
    store,
    expected,
    quote,
    envelopes,
    calls,
    get confirmations() {
      return confirmations;
    },
    setBalance(v: string) {
      balance = v;
    },
    setStatus(v: string) {
      status = v;
    },
    setClock(v: number) {
      clock = v;
    },
    setOriginValid(v: boolean) {
      originValid = v;
    },
    setBalanceHook(v: (() => Promise<void>) | undefined) {
      balanceHook = v;
    },
  };
}
test("minimum return retains only the quoted lower bound and immutable observation across replicas and consumption", async () => {
  const f = fixture(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  f.setBalance("1995100");
  const expected = {
    ...f.expected,
    baselineEnvelope: baseline.baselineEnvelope,
  };
  const proof = await f.service().minimumReturn(signed, expected);
  assert.equal(proof.status, "minimumReceived");
  assert.equal(proof.verifiedMinimumAtoms, "990000");
  assert.equal(proof.observedAtMs, now);
  assert.equal(proof.verification, "minimum-return-v1");
  assert.equal(proof.spendingAuthorized, false);
  assert.equal(proof.exactAmountKnown, false);
  assert.equal("creditedAtoms" in proof, false);
  assert.equal("settlementEnvelope" in proof, false);
  assert.ok(proof.minimumReturnEnvelope);
  f.setBalance("0");
  f.setClock(now + 1000);
  const calls = f.calls.length;
  const replay = await f
    .service()
    .minimumReturn(await auth(now + 1000), { ...expected, revision: 9 });
  assert.equal(replay.observedAtMs, now);
  assert.equal(replay.timestampMs, now + 1000);
  assert.equal(f.calls.length, calls);
  assert.equal(f.confirmations, 1);
  assert.equal(f.store.receipts.size, 1);
  assert.deepEqual([...f.store.sequences.values()], ["1"]);
  assert.throws(() =>
    f.envelopes.open("source-credit", proof.minimumReturnEnvelope!),
  );
  assert.ok(!f.calls.some((v) => v.includes("history")));
  const persisted = JSON.stringify([...f.store.receipts.values()]);
  for (const secret of [
    C,
    owner,
    deposit,
    tx,
    signed.payload,
    signed.signature,
    "PRIVATE",
    "1995100",
  ])
    assert.equal(persisted.includes(secret), false);
});
function otherRoute(
  f: ReturnType<typeof fixture>,
  id = "return_2",
  address = "0x" + "4".repeat(40),
) {
  const quote = { ...f.quote, operationId: id, recipient: address };
  return {
    ...f.expected,
    operationId: id,
    depositAddress: address,
    transactionHash: "0x" + "b".repeat(64),
    quoteEnvelope: f.envelopes.seal("native-quote", {
      quote,
      settlement: quote,
    }),
  };
}
test("pending minimum evidence carries zero and explicit nonspending flags without a reusable receipt", async () => {
  const f = fixture(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  const expected = {
    ...f.expected,
    baselineEnvelope: baseline.baselineEnvelope,
  };
  for (const [status, balance] of [
    ["PROCESSING", "1995100"],
    ["SUCCESS", "100"],
    ["SUCCESS", "990099"],
  ]) {
    f.setStatus(status!);
    f.setBalance(balance!);
    const proof = await f.service().minimumReturn(signed, expected);
    assert.equal(proof.status, "awaitingSettlement");
    assert.equal(proof.verifiedMinimumAtoms, "0");
    assert.equal(proof.observedAtMs, now);
    assert.equal(proof.minimumReturnEnvelope, undefined);
    assert.equal(proof.spendingAuthorized, false);
    assert.equal(proof.exactAmountKnown, false);
    assert.equal("creditedAtoms" in proof, false);
    assert.equal(f.store.receipts.size, 0);
  }
});
test("concurrent replicas confirm the same route only once and reject overlapping different routes", async () => {
  for (const different of [false, true]) {
    const f = fixture(),
      signed = await auth(),
      baseline = await f.service().baseline(signed);
    f.setBalance("1995100");
    const expected = {
      ...f.expected,
      baselineEnvelope: baseline.baselineEnvelope,
    };
    const other = {
      ...(different ? otherRoute(f) : f.expected),
      baselineEnvelope: baseline.baselineEnvelope,
    };
    const outcomes = await Promise.allSettled([
      f.service().minimumReturn(signed, expected),
      f.service().minimumReturn(signed, other),
    ]);
    assert.equal(
      outcomes.filter((v) => v.status === "fulfilled").length,
      different ? 1 : 2,
    );
    assert.equal(f.store.receipts.size, 1);
    assert.deepEqual([...f.store.sequences.values()], ["1"]);
  }
});
test("legacy migration is first claim only; fenced sequential snapshots retain surplus and permit outflows", async () => {
  const f = fixture(),
    signed = await auth(),
    baseline = await f.service().baseline(signed);
  const unfenced = f.envelopes.open(
    "private-balance",
    baseline.baselineEnvelope,
  ) as Record<string, unknown>;
  delete unfenced.observationSequence;
  const legacy = f.envelopes.seal("private-balance", unfenced);
  f.setBalance("1995100");
  await f
    .service()
    .minimumReturn(signed, { ...f.expected, baselineEnvelope: legacy });
  const second = otherRoute(f);
  await assert.rejects(
    f.service().minimumReturn(signed, { ...second, baselineEnvelope: legacy }),
    { code: "EARN_MINIMUM_RETURN_CONFLICT" },
  );
  await assert.rejects(
    f.service().minimumReturn(signed, {
      ...second,
      baselineEnvelope: baseline.baselineEnvelope,
    }),
    { code: "EARN_MINIMUM_RETURN_CONFLICT" },
  );
  f.setBalance("123");
  const next = await f.service().baseline(signed);
  assert.equal(next.observationSequence, "1");
  f.setBalance("1000123");
  const proof = await f.service().minimumReturn(signed, {
    ...second,
    baselineEnvelope: next.baselineEnvelope,
  });
  assert.equal(proof.verifiedMinimumAtoms, "990000");
  assert.deepEqual([...f.store.sequences.values()], ["2"]);
});
test("snapshot is rejected if a concurrent confirmation advances the sequence during the balance read", async () => {
  const f = fixture(),
    signed = await auth();
  const baseline = await f.service().baseline(signed);
  f.setBalance("990100");
  await f.service().minimumReturn(signed, {
    ...f.expected,
    baselineEnvelope: baseline.baselineEnvelope,
  });
  f.setBalanceHook(async () => {
    for (const key of f.store.sequences.keys()) f.store.sequences.set(key, "2");
  });
  await assert.rejects(f.service().baseline(signed), {
    code: "EARN_MINIMUM_RETURN_CONFLICT",
  });
});
test("minimum verification preserves quote, baseline, owner and asset checks and rejects changed replay bindings", async () => {
  for (const origin of [
    robinhoodUsdgAssetId,
    ethereumUsdcAssetId,
    "nep141:eth.omft.near",
  ]) {
    const f = fixture(origin),
      signed = await auth(),
      baseline = await f.service().baseline(signed);
    f.setBalance("1995100");
    const expected = {
      ...f.expected,
      baselineEnvelope: baseline.baselineEnvelope,
    };
    for (const patch of [
      { amountAtoms: "1000001" },
      { minimumCreditAtoms: "990001" },
      { maximumCreditAtoms: "995001" },
      { confidentialAccount: owner },
      { originAsset: monadUsdcAssetId },
      { settlementEnvelope: "exact-envelope" },
    ])
      await assert.rejects(
        f.service().minimumReturn(signed, { ...expected, ...patch }),
      );
    const value = f.envelopes.open(
      "private-balance",
      baseline.baselineEnvelope,
    ) as Record<string, unknown>;
    for (const patch of [
      { confidentialAddress: owner },
      { timestampMs: now - 60001 },
      { timestampMs: now + 601000 },
      { assetId: "wrong" },
      { authenticated: false },
      { operationScoped: true },
    ])
      await assert.rejects(
        f.service().minimumReturn(signed, {
          ...expected,
          baselineEnvelope: f.envelopes.seal("private-balance", {
            ...value,
            ...patch,
          }),
        }),
      );
    assert.equal(
      (await f.service().minimumReturn(signed, expected)).status,
      "minimumReceived",
    );
    await assert.rejects(
      f.service().minimumReturn(signed, {
        ...expected,
        transactionHash: "0x" + "c".repeat(64),
      }),
      { code: "EARN_MINIMUM_RETURN_CONFLICT" },
    );
    await assert.rejects(
      f
        .service()
        .minimumReturn(signed, { ...expected, operationId: "changed" }),
      { code: "EARN_MINIMUM_RETURN_CONFLICT" },
    );
  }
});
test("unconfirmed origin, reduced balance and missing or failed durable store fail closed with sanitized errors", async () => {
  const f = fixture(),
    signed = await auth(),
    baseline = await f.service().baseline(signed),
    expected = { ...f.expected, baselineEnvelope: baseline.baselineEnvelope };
  f.setBalance("1995100");
  f.setOriginValid(false);
  await assert.rejects(
    f.service().minimumReturn(signed, expected),
    (error: any) =>
      error.code === "EARN_MINIMUM_RETURN_UNAVAILABLE" &&
      !error.message.includes("PRIVATE"),
  );
  assert.equal(f.store.receipts.size, 0);
  f.setOriginValid(true);
  f.setBalance("99");
  await assert.rejects(f.service().minimumReturn(signed, expected));
  await assert.rejects(
    f.service({ store: undefined }).minimumReturn(signed, expected),
    { statusCode: 503 },
  );
  const broken: MinimumReturnStore = {
    async sequence() {
      throw Error("PRIVATE-DB-URL");
    },
    async receipt() {
      throw Error("PRIVATE-DB-URL");
    },
    async finish() {
      throw Error("PRIVATE-DB-URL");
    },
  };
  await assert.rejects(
    f.service({ store: broken }).minimumReturn(signed, expected),
    (error: any) =>
      error.statusCode === 503 && !error.message.includes("PRIVATE"),
  );
  await assert.rejects(f.service({ store: broken }).baseline(signed), {
    statusCode: 503,
  });
});

test("minimum capability routes to independent service with the unchanged body and fenced baseline", async () => {
  const f = fixture(),
    signed = await auth();
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerEarnSettlementRoutes(app, new ConfidentialSettlement(), f.service());
  try {
    const baseline = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement-baseline",
      payload: { signedData: signed },
    });
    assert.equal(baseline.statusCode, 200);
    assert.equal(baseline.json().observationSequence, "0");
    const payload = {
      signedData: signed,
      expected: {
        ...f.expected,
        baselineEnvelope: baseline.json().baselineEnvelope,
      },
    };
    f.setBalance("1995100");
    const proof = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement",
      payload,
      headers: { "x-gizu-settlement-proof": "minimum-return-v1" },
    });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.json().status, "minimumReceived");
    assert.equal(proof.json().verifiedMinimumAtoms, "990000");
    assert.equal(proof.json().creditedAtoms, undefined);
    assert.equal(proof.headers["cache-control"], "no-store");
    const legacy = await app.inject({
      method: "POST",
      url: "/v1/earn/native/settlement",
      payload,
    });
    assert.equal(legacy.statusCode, 503);
  } finally {
    await app.close();
  }
});
