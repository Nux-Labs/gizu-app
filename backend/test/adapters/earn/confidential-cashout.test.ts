import test from "node:test";
import assert from "node:assert/strict";
import { ConfidentialCashoutGateway } from "../../../src/adapters/earn/confidential-cashout.ts";
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
