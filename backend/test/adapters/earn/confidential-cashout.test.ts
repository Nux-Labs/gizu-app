import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ConfidentialCashoutGateway } from "../../../src/adapters/earn/confidential-cashout.ts";
import { OperationCoordinator } from "../../../src/adapters/earn/operation-coordinator.ts";
import { registerConfidentialCashoutRoutes } from "../../../src/http/routes/confidential-cashout.routes.ts";
const C = "0x1000000000000000000000000000000000000001",
  R = "0x2000000000000000000000000000000000000002";
const at = Date.parse("2026-11-05T12:00:00Z");
const auth = { standard: "erc191", payload: "auth", signature: "signature" };
function fixture() {
  const bindings = new Map<string, string>();
  const coordination = {
    bind: async (scope: string, identity: unknown, binding: unknown) => {
      const key = scope + JSON.stringify(identity),
        value = JSON.stringify(binding);
      if (bindings.has(key) && bindings.get(key) !== value)
        throw Error("Receipt already consumed");
      bindings.set(key, value);
    },
  };
  const history: any[] = [];
  const providers = {
    authenticate: async () => C,
    balance: async () => ({
      available: "3000000",
      confidentialAddress: C,
      assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
      timestampMs: at,
      authenticated: true,
      operationScoped: false,
    }),
    quote: async (request: any) => ({
      quoteRequest: request,
      signature: "provider",
      quote: {
        depositAddress: "deposit",
        amountIn: request.amount,
        amountOut: "990000",
        minAmountOut: "980000",
        deadline: new Date(at + 240000).toISOString(),
      },
    }),
    intent: async () => ({ standard: "erc191", payload: "spend" }),
    verify: async () => C,
    history: async () => history,
    reference: async () => ({
      referenceBlock: "100",
      referenceHash: "0x" + "a".repeat(64),
      initialDestinationAtoms: "0",
    }),
    confirm: async (_q: any, hash: string, amount: string) => ({
      transactionHash: hash,
      receivedAtoms: amount,
      logIndex: 7,
    }),
  };
  return {
    coordination,
    gateway: new ConfidentialCashoutGateway(
      { recoveryKey: "ab".repeat(32), coordination },
      providers,
      () => at,
    ),
    history,
    providers,
  };
}
function receiptOnlyFixture() {
  const f = fixture();
  let route = "PROCESSING";
  const payload = JSON.stringify({
    signer_id: C,
    verifying_contract: "intents.far",
    nonce: Buffer.alloc(32, 1).toString("base64"),
    deadline: new Date(at + 60000).toISOString(),
    intents: [
      {
        intent: "transfer",
        receiver_id: "deposit",
        tokens: {
          ["imt:" +
          "a".repeat(64) +
          ":nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"]:
            "1000000",
        },
      },
    ],
  });
  f.providers.intent = async () => ({ standard: "erc191", payload });
  const providers = {
    ...f.providers,
    history: async (): Promise<any[]> => {
      throw Error("History must never be requested");
    },
    routeStatus: async () => ({ status: route }),
    confirmReceipt: async (_q: any, hash: string) => ({
      transactionHash: hash,
      receivedAtoms: "995012",
      blockNumber: "101",
      blockHash: "0x" + "c".repeat(64),
      logIndex: 2,
    }),
  };
  const create = () =>
    new ConfidentialCashoutGateway(
      { recoveryKey: "ab".repeat(32), coordination: f.coordination },
      providers,
      () => at,
    );
  return {
    ...f,
    providers,
    create,
    setRoute: (value: string) => {
      route = value;
    },
  };
}
function receiptCompatibilityFixture() {
  const f = receiptOnlyFixture();
  // Model the permanent store boundary: only opaque keyed commitments survive restart.
  const commitments = new Map<string, string>();
  const coordination = new OperationCoordinator(
    {
      bind: async (key, commitment) => {
        if (commitments.has(key) && commitments.get(key) !== commitment)
          return false;
        commitments.set(key, commitment);
        return true;
      },
    },
    "cd".repeat(32),
  );
  const create = (legacy = false) =>
    new ConfidentialCashoutGateway(
      { recoveryKey: "ab".repeat(32), coordination },
      legacy
        ? {
            ...f.providers,
            history: async () => f.history,
            confirm: async (q, hash, received) => {
              const receipt = await f.providers.confirmReceipt(q, hash);
              assert.equal(receipt.receivedAtoms, received);
              return receipt;
            },
          }
        : f.providers,
      () => at,
    );
  const prepare = async (operationId = "cash_compat", recipient = R) => {
    const prepared = await create(true).prepare({
      operationId,
      recipient,
      amountAtoms: "1000000",
      signedData: auth,
    });
    return {
      signedData: auth,
      recoveryEnvelope: prepared.recoveryEnvelope,
      submittedIntent: { ...prepared.intent, signature: "signed" },
      destinationTransactionHash: "0x" + "b".repeat(64),
    };
  };
  f.history.push({
    depositAddress: "deposit",
    status: "SUCCESS",
    depositType: "CONFIDENTIAL_INTENTS",
    recipientType: "DESTINATION_CHAIN",
    refundType: "CONFIDENTIAL_INTENTS",
    originAsset: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    destinationAsset:
      "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    recipient: R,
    refundTo: C,
    amountInFormatted: "1",
    amountOutFormatted: "0.995012",
    createdAt: new Date(at).toISOString(),
    quoteTransactions: [{ sender: C, txHash: "intent1" }],
  });
  f.setRoute("SUCCESS");
  return { ...f, create, prepare, commitments };
}
test("receipt mode restores a legacy committed delivery after its paid response was lost", async () => {
  const f = receiptCompatibilityFixture();
  const request = await f.prepare();
  assert.equal((await f.create(true).status(request)).status, "paid");
  // The upgraded client retained the original signed child and submission hash.
  const restored = await f
    .create()
    .status({ ...request, intentHash: "intent1" }, true);
  assert.equal(restored.status, "paid");
  assert.equal(restored.verification, "destination-receipt-v1");
  assert.equal(restored.receivedAtoms, "995012");
  assert.ok(
    [...f.commitments].every(
      ([key, value]) =>
        /^[0-9a-f]{64}$/.test(key) && /^[0-9a-f]{64}$/.test(value),
    ),
  );
});
test("receipt mode first committed with a known hash remains recoverable from a hashless backup", async () => {
  const f = receiptCompatibilityFixture();
  const request = { ...(await f.prepare()), intentHash: "intent1" };
  assert.equal((await f.create().status(request, true)).status, "paid");
  const { intentHash: _intentHash, ...hashlessBackup } = request;
  const restored = await f.create().status(hashlessBackup, true);
  assert.equal(restored.status, "paid");
  assert.equal(restored.verification, "destination-receipt-v1");
  // Legacy clients cannot consume a new commitment; ownership is never reassigned.
  await assert.rejects(f.create(true).status(request), /consumed/);
});
test("receipt mode retries a hashless claim when its submission hash later becomes available", async () => {
  const f = receiptCompatibilityFixture();
  const request = await f.prepare();
  assert.equal((await f.create().status(request, true)).status, "paid");
  assert.equal(
    (await f.create().status({ ...request, intentHash: "intent1" }, true))
      .status,
    "paid",
  );
  assert.equal((await f.create().status(request, true)).status, "paid");
});
test("receipt mode never replaces a legacy claim whose original submission hash is unknown", async () => {
  const f = receiptCompatibilityFixture();
  const request = await f.prepare();
  assert.equal((await f.create(true).status(request)).status, "paid");
  for (const intentHash of [undefined, "other-intent"])
    await assert.rejects(
      f.create().status({ ...request, intentHash }, true),
      /consumed/,
    );
  assert.equal((await f.create(true).status(request)).status, "paid");
});
test("receipt compatibility cannot reassign an event to another signed child or payload", async () => {
  for (const claimMode of [
    "legacy",
    "receipt-with-hash",
    "receipt-without-hash",
  ]) {
    const f = receiptCompatibilityFixture();
    const legacyClaim = claimMode === "legacy";
    const request = {
      ...(await f.prepare()),
      ...(claimMode === "receipt-without-hash"
        ? {}
        : { intentHash: "intent1" }),
    };
    const otherChild = await f.prepare(
      "cash_other",
      "0x3000000000000000000000000000000000000003",
    );
    const payload = JSON.parse(request.submittedIntent.payload);
    payload.nonce = Buffer.alloc(32, 2).toString("base64");
    f.providers.intent = async () => ({
      standard: "erc191",
      payload: JSON.stringify(payload),
    });
    const otherPayload = await f.prepare();
    assert.equal(
      (await f.create(legacyClaim).status(request, !legacyClaim)).status,
      "paid",
    );
    await assert.rejects(
      f.create().status({ ...otherChild, intentHash: "intent1" }, true),
      /consumed/,
    );
    await assert.rejects(
      f.create().status({ ...otherPayload, intentHash: "intent1" }, true),
      /consumed/,
    );
    assert.equal(
      (await f.create(legacyClaim).status(request, !legacyClaim)).status,
      "paid",
    );
  }
});
test("cashout receipt mode verifies actual public delivery without history and survives restart", async () => {
  const f = receiptOnlyFixture();
  const prepared = await f.create().prepare(
    {
      operationId: "cash_receipt",
      recipient: R,
      amountAtoms: "1000000",
      signedData: auth,
    },
    true,
  );
  const request = {
    signedData: auth,
    recoveryEnvelope: prepared.recoveryEnvelope,
    submittedIntent: { ...prepared.intent, signature: "signed" },
  };
  assert.equal((await f.create().status(request, true)).status, "pending");
  f.setRoute("SUCCESS");
  const waiting = await f.create().status(request, true);
  assert.equal(waiting.status, "awaitingReceipt");
  assert.equal(waiting.receivedAtoms, "0");
  assert.equal(waiting.verification, "destination-receipt-v1");
  const paid = await f
    .create()
    .status(
      { ...request, destinationTransactionHash: "0x" + "b".repeat(64) },
      true,
    );
  assert.equal(paid.status, "paid");
  assert.equal(paid.receivedAtoms, "995012");
  assert.equal(paid.verification, "destination-receipt-v1");
  assert.deepEqual(
    await f
      .create()
      .status(
        { ...request, destinationTransactionHash: "0x" + "b".repeat(64) },
        true,
      ),
    paid,
  );
  await assert.rejects(
    f.create().prepare(
      {
        operationId: "cash_other",
        recipient: R,
        amountAtoms: "1000000",
        signedData: auth,
      },
      true,
    ),
    /consumed/,
  );
});
test("cashout receipt mode rejects unfresh recipients, failed routes and invalid delivery evidence", async () => {
  for (const change of [
    "nonzero-recipient",
    "failed-route",
    "below-minimum",
    "changed-signer",
    "changed-payload",
    "changed-hash",
    "bad-event",
  ]) {
    const f = receiptOnlyFixture();
    if (change === "nonzero-recipient")
      f.providers.reference = async () => ({
        referenceBlock: "100",
        referenceHash: "0x" + "a".repeat(64),
        initialDestinationAtoms: "1",
      });
    const gateway = f.create();
    if (change === "nonzero-recipient") {
      await assert.rejects(
        gateway.prepare(
          {
            operationId: "cash_receipt",
            recipient: R,
            amountAtoms: "1000000",
            signedData: auth,
          },
          true,
        ),
      );
      continue;
    }
    const prepared = await gateway.prepare(
      {
        operationId: "cash_receipt",
        recipient: R,
        amountAtoms: "1000000",
        signedData: auth,
      },
      true,
    );
    const request = {
      signedData: auth,
      recoveryEnvelope: prepared.recoveryEnvelope,
      submittedIntent: { ...prepared.intent, signature: "signed" },
      destinationTransactionHash: "0x" + "b".repeat(64),
    };
    f.setRoute(change === "failed-route" ? "REFUNDED" : "SUCCESS");
    if (change === "changed-signer") f.providers.authenticate = async () => R;
    if (change === "changed-payload") request.submittedIntent.payload += " ";
    if (["below-minimum", "changed-hash", "bad-event"].includes(change))
      f.providers.confirmReceipt = async () => ({
        transactionHash:
          change === "changed-hash"
            ? "0x" + "d".repeat(64)
            : request.destinationTransactionHash,
        receivedAtoms: change === "below-minimum" ? "979999" : "995012",
        blockNumber: "101",
        blockHash: "0x" + "c".repeat(64),
        logIndex: change === "bad-event" ? -1 : 2,
      });
    await assert.rejects(gateway.status(request, true), /./, change);
  }
});
test("cashout route explicitly negotiates public receipt evidence without changing the body", async () => {
  const f = receiptOnlyFixture();
  const app = Fastify({ logger: false });
  registerConfidentialCashoutRoutes(app, f.create());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/prepare",
      headers: { "x-gizu-payout-proof": "destination-receipt-v1" },
      payload: {
        operationId: "cash_route",
        recipient: R,
        amountAtoms: "1000000",
        signedData: { ...auth, signature: "secp256k1:" + "1".repeat(87) },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    f.setRoute("SUCCESS");
    const prepared = response.json();
    const checked = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/status",
      headers: { "x-gizu-payout-proof": "destination-receipt-v1" },
      payload: {
        signedData: { ...auth, signature: "secp256k1:" + "1".repeat(87) },
        recoveryEnvelope: prepared.recoveryEnvelope,
        submittedIntent: {
          ...prepared.intent,
          signature: "secp256k1:" + "1".repeat(87),
        },
      },
    });
    assert.equal(checked.statusCode, 200);
    assert.equal(checked.json().verification, "destination-receipt-v1");
    assert.equal(checked.json().status, "awaitingReceipt");
    const legacy = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/status",
      payload: {
        signedData: { ...auth, signature: "secp256k1:" + "1".repeat(87) },
        recoveryEnvelope: prepared.recoveryEnvelope,
        submittedIntent: {
          ...prepared.intent,
          signature: "secp256k1:" + "1".repeat(87),
        },
      },
    });
    assert.equal(legacy.statusCode, 503);
  } finally {
    await app.close();
  }
});
test("cashout preparation binds authenticated source and exact debit independently of sale or return credit", async () => {
  const f = fixture();
  const p = await f.gateway.prepare({
    operationId: "cash_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  assert.equal(p.amountAtoms, "1000000");
  assert.equal(p.confidentialAccount, C);
  assert.equal(p.minimumDestinationAtoms, "980000");
  assert.ok(p.recoveryEnvelope.startsWith("v1."));
  await assert.rejects(
    f.gateway.prepare({
      operationId: "cash_1_1",
      amountAtoms: "3000001",
      recipient: R,
      signedData: auth,
    }),
    /Insufficient/,
  );
});
test("cashout status survives process restart and requires exact authenticated private history before a receipt can pay a child", async () => {
  const f = fixture();
  const p = await f.gateway.prepare({
    operationId: "cash_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  const input = {
    recoveryEnvelope: p.recoveryEnvelope,
    signedData: auth,
    submittedIntent: {
      standard: "erc191",
      payload: "spend",
      signature: "signed",
    },
    destinationTransactionHash: "0x" + "b".repeat(64),
  };
  assert.equal((await f.gateway.status(input)).status, "pending");
  f.history.push({
    depositAddress: "deposit",
    status: "SUCCESS",
    depositType: "CONFIDENTIAL_INTENTS",
    recipientType: "DESTINATION_CHAIN",
    refundType: "CONFIDENTIAL_INTENTS",
    originAsset: p.assetId,
    destinationAsset: p.assetId,
    recipient: R,
    refundTo: C,
    amountInFormatted: "1",
    amountOutFormatted: "0.99",
    createdAt: new Date(at).toISOString(),
    quoteTransactions: [{ sender: C, txHash: "intent1" }],
  });
  const restarted = new ConfidentialCashoutGateway(
    { recoveryKey: "ab".repeat(32), coordination: f.coordination },
    f.providers,
    () => at,
  );
  assert.equal((await restarted.status(input)).status, "paid");
  f.history[0].recipient = C;
  await assert.rejects(restarted.status(input), /Changed/);
});
test("cashout rejects changed signed bytes, duplicate history, foreign auth and tampered recovery envelope", async () => {
  const f = fixture();
  const p = await f.gateway.prepare({
    operationId: "cash_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  const input = {
    recoveryEnvelope: p.recoveryEnvelope,
    signedData: auth,
    submittedIntent: {
      standard: "erc191",
      payload: "other",
      signature: "signed",
    },
  };
  await assert.rejects(f.gateway.status(input), /Changed/);
  input.submittedIntent.payload = "spend";
  f.providers.authenticate = async () => R;
  await assert.rejects(f.gateway.status(input), /Changed/);
  await assert.rejects(
    f.gateway.status({ ...input, recoveryEnvelope: p.recoveryEnvelope + "x" }),
  );
});

test("one canonical receipt event cannot pay different equal-value children across backend restarts", async () => {
  const f = fixture();
  const a = await f.gateway.prepare({
    operationId: "cash_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  const b = await f.gateway.prepare({
    operationId: "cash_1_1",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  const row = {
    depositAddress: "deposit",
    status: "SUCCESS",
    depositType: "CONFIDENTIAL_INTENTS",
    recipientType: "DESTINATION_CHAIN",
    refundType: "CONFIDENTIAL_INTENTS",
    originAsset: a.assetId,
    destinationAsset: a.assetId,
    recipient: R,
    refundTo: C,
    amountInFormatted: "1",
    amountOutFormatted: "0.99",
    createdAt: new Date(at).toISOString(),
    quoteTransactions: [{ sender: C, txHash: "intent1" }],
  };
  f.history.push(row);
  const input = {
    recoveryEnvelope: a.recoveryEnvelope,
    signedData: auth,
    submittedIntent: {
      standard: "erc191",
      payload: "spend",
      signature: "signed",
    },
    destinationTransactionHash: "0x" + "b".repeat(64),
  };
  assert.equal((await f.gateway.status(input)).status, "paid");
  const restarted = new ConfidentialCashoutGateway(
    { recoveryKey: "ab".repeat(32), coordination: f.coordination },
    f.providers,
    () => at,
  );
  assert.equal((await restarted.status(input)).status, "paid");
  await assert.rejects(
    restarted.status({ ...input, recoveryEnvelope: b.recoveryEnvelope }),
    /consumed/,
  );
});

test("cashout fails closed without durable receipt coordination", async () => {
  const f = fixture();
  const gateway = new ConfidentialCashoutGateway(
    { recoveryKey: "ab".repeat(32) },
    f.providers,
    () => at,
  );
  await assert.rejects(
    gateway.prepare({
      operationId: "cash_1_0",
      amountAtoms: "1000000",
      recipient: R,
      signedData: auth,
    }),
    /durable coordination/,
  );
});
test("cashout rejects non-finite authenticated history timestamps", async () => {
  const f = fixture();
  const p = await f.gateway.prepare({
    operationId: "cash_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  });
  f.history.push({
    depositAddress: "deposit",
    status: "SUCCESS",
    depositType: "CONFIDENTIAL_INTENTS",
    recipientType: "DESTINATION_CHAIN",
    refundType: "CONFIDENTIAL_INTENTS",
    originAsset: p.assetId,
    destinationAsset: p.assetId,
    recipient: R,
    refundTo: C,
    amountInFormatted: "1",
    amountOutFormatted: "0.99",
    createdAt: "NaN",
    quoteTransactions: [{ sender: C, txHash: "intent1" }],
  });
  await assert.rejects(
    f.gateway.status({
      recoveryEnvelope: p.recoveryEnvelope,
      signedData: auth,
      submittedIntent: {
        standard: "erc191",
        payload: "spend",
        signature: "signed",
      },
      destinationTransactionHash: "0x" + "b".repeat(64),
    }),
    /Changed cashout history/,
  );
});
