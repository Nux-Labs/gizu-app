import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { hexToBytes, toHex, encodeEventTopics, erc20Abi } from "viem";
import * as gateways from "../../../src/adapters/earn/confidential-cashout.ts";
import * as routes from "../../../src/http/routes/confidential-cashout.routes.ts";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import { observedAuroraFeeQualification } from "../../../src/adapters/earn/fee-policy.ts";
const C = "0x1000000000000000000000000000000000000001";
const R = "0x2000000000000000000000000000000000000002";
const at = Date.parse("2026-11-05T12:00:00Z");
const source = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
const destination =
  "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near";
const auth = {
  standard: "erc191",
  payload: "auth",
  signature: "secp256k1:" + "1".repeat(87),
};
const tx = "0x" + "b".repeat(64);
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
  const message = {
    signer_id: C,
    verifying_contract: "intents.far",
    nonce: Buffer.alloc(32, 1).toString("base64"),
    deadline: new Date(at + 240000).toISOString(),
    intents: [
      {
        intent: "transfer",
        receiver_id: "deposit",
        tokens: { ["imt:" + "a".repeat(64) + ":" + source]: "1000000" },
      },
    ],
  };
  const providers = {
    authenticate: async () => C,
    balance: async () => ({
      available: "3000000",
      confidentialAddress: C,
      assetId: source,
      timestampMs: at,
      authenticated: true,
      operationScoped: false,
    }),
    quote: async (request: any) => ({
      quoteRequest: { ...request },
      signature: "provider",
      quote: {
        depositAddress: "deposit",
        amountIn: request.amount,
        amountOut: "990000",
        minAmountOut: "980000",
        deadline: new Date(at + 240000).toISOString(),
      },
    }),
    intent: async () => ({
      standard: "erc191",
      payload: JSON.stringify(message),
    }),
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
      blockNumber: "101",
      blockHash: "0x" + "c".repeat(64),
      logIndex: 7,
    }),
  };
  const config = { recoveryKey: "ab".repeat(32), coordination };
  const Constructor = (gateways as any).ConfidentialPrivateFundingGateway;
  assert.equal(
    typeof Constructor,
    "function",
    "private funding gateway must exist",
  );
  const create = () => new Constructor(config, providers, () => at);
  const prepare = {
    operationId: "deposit_1_0",
    amountAtoms: "1000000",
    recipient: R,
    signedData: auth,
  };
  const successfulHistory = () => ({
    depositAddress: "deposit",
    status: "SUCCESS",
    depositType: "CONFIDENTIAL_INTENTS",
    recipientType: "DESTINATION_CHAIN",
    refundType: "CONFIDENTIAL_INTENTS",
    originAsset: source,
    destinationAsset: destination,
    recipient: R,
    refundTo: C,
    amountInFormatted: "1",
    amountOutFormatted: "0.99",
    createdAt: new Date(at).toISOString(),
    quoteTransactions: [{ sender: C, txHash: "intent1" }],
  });
  const status = (p: any) => ({
    recoveryEnvelope: p.recoveryEnvelope,
    signedData: auth,
    submittedIntent: { ...p.intent, signature: auth.signature },
    intentHash: "intent1",
    destinationTransactionHash: tx,
  });
  return {
    create,
    gateway: create(),
    providers,
    config,
    coordination,
    bindings,
    message,
    history,
    prepare,
    successfulHistory,
    status,
  };
}
test("private funding directly prepares advanced exact-input Monad USDC to Robinhood USDG", async () => {
  const f = fixture(),
    p = await f.gateway.prepare(f.prepare);
  assert.equal(p.destinationChainId, 4663);
  assert.equal(
    p.destinationToken.toLowerCase(),
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  );
  assert.equal(p.destinationRecipient, R);
  assert.equal(p.assetId, source);
  assert.equal(p.destinationAssetId, destination);
  assert.equal(p.amountAtoms, "1000000");
  assert.equal(p.providerFeeBps, 0);
  assert.equal(p.quoteRequest.destinationAsset, destination);
  assert.equal(p.quoteRequest.swapType, "EXACT_INPUT");
  assert.equal(p.quoteRequest.confidentiality, "advanced");
  assert.equal(p.quoteRequest.slippageTolerance, 100);
  assert.equal(p.quoteRequest.appFees, undefined);
  assert.equal(Date.parse(JSON.parse(p.intent.payload).deadline), at + 60000);
});
test("private funding binds the same qualified service fees as its preview", async () => {
  const f = fixture();
  const quote = f.providers.quote;
  f.providers.quote = async (request: any) => {
    const response: any = await quote(request);
    response.quoteRequest.appFees = [
      { fee: 25, recipient: "widget_collect.sputnik-dao.near" },
      {
        recipient:
          "2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805",
        fee: 20,
      },
    ];
    response.quoteRequest.referral = "aurora-jh500bnyo9";
    return response;
  };
  const gateway = new gateways.ConfidentialPrivateFundingGateway(
    { ...f.config, auroraFeeQualification: observedAuroraFeeQualification },
    f.providers,
    () => at,
  );
  const prepared = await gateway.prepare(f.prepare);
  assert.equal(prepared.providerFeeBps, 45);
  assert.equal(prepared.feePolicy.route, "payoutRobinhood");
  assert.equal(prepared.feePolicy.totalBps, 45);
  assert.equal(prepared.feePolicy.integratorFeeBps, 0);
  assert.equal(prepared.feePolicy.applicationFeeAtoms, "0");
  assert.equal(prepared.minimumDestinationAtoms, "980000");
  const recovered: any = new EarnRecoveryEnvelope(f.config.recoveryKey).open(
    "confidential-private-funding",
    prepared.recoveryEnvelope,
  );
  assert.deepEqual(recovered.feePolicy, prepared.feePolicy);
  f.providers.quote = async (request: any) => {
    const response: any = await quote(request);
    response.quoteRequest.appFees = [{ recipient: "unqualified.near", fee: 1 }];
    response.quoteRequest.referral = "aurora-jh500bnyo9";
    return response;
  };
  await assert.rejects(gateway.prepare(f.prepare));
});
test("private funding authenticates history then exact receipt and remains recoverable after restart", async () => {
  const f = fixture(),
    p = await f.gateway.prepare(f.prepare),
    input = f.status(p);
  assert.equal((await f.gateway.status(input)).status, "pending");
  f.history.push(f.successfulHistory());
  assert.equal(
    (
      await f.gateway.status({
        ...input,
        destinationTransactionHash: undefined,
      })
    ).status,
    "awaitingReceipt",
  );
  const paid = await f.create().status(input);
  assert.equal(paid.status, "paid");
  assert.equal(paid.receivedAtoms, "990000");
  assert.equal(paid.destinationChainId, 4663);
  assert.equal(paid.destinationAssetId, destination);
  assert.equal((await f.create().status(input)).status, "paid");
  f.message.nonce = Buffer.alloc(32, 2).toString("base64");
  const other = await f.gateway.prepare({
    ...f.prepare,
    operationId: "deposit_1_1",
  });
  await assert.rejects(f.create().status(f.status(other)), /consumed/);
});
test("private funding and cashout recovery domains reject one another and cashout stays Monad-only", async () => {
  const f = fixture(),
    cashout = new gateways.ConfidentialCashoutGateway(
      f.config,
      f.providers,
      () => at,
    );
  const privateQuote = await f.gateway.prepare(f.prepare),
    publicQuote = await cashout.prepare(f.prepare);
  assert.equal(publicQuote.destinationChainId, 143);
  assert.equal(publicQuote.quoteRequest.destinationAsset, source);
  await assert.rejects(cashout.status(f.status(privateQuote)));
  await assert.rejects(f.gateway.status(f.status(publicQuote)));
});
for (const change of [
  "source",
  "asset",
  "stale",
  "unauthenticated",
  "operationScoped",
  "insufficient",
] as const)
  test(`private funding rejects ${change} balance evidence`, async () => {
    const f = fixture(),
      balance: any = await f.providers.balance();
    if (change === "source") balance.confidentialAddress = R;
    if (change === "asset") balance.assetId = destination;
    if (change === "stale") balance.timestampMs = at - 60001;
    if (change === "unauthenticated") balance.authenticated = false;
    if (change === "operationScoped") balance.operationScoped = true;
    if (change === "insufficient") balance.available = "999999";
    f.providers.balance = async () => balance;
    await assert.rejects(f.gateway.prepare(f.prepare));
  });
for (const change of [
  "destination",
  "recipient",
  "origin",
  "confidentiality",
  "slippage",
  "fees",
  "quoteFees",
  "responseFees",
  "feeBps",
  "minimum",
  "extraEffect",
] as const)
  test(`private funding rejects changed quote ${change}`, async () => {
    const f = fixture(),
      quote = f.providers.quote;
    f.providers.quote = async (request: any) => {
      const response: any = await quote(request);
      if (change === "destination")
        response.quoteRequest.destinationAsset = source;
      if (change === "recipient") response.quoteRequest.recipient = C;
      if (change === "origin") response.quoteRequest.originAsset = destination;
      if (change === "confidentiality")
        response.quoteRequest.confidentiality = "standard";
      if (change === "slippage") response.quoteRequest.slippageTolerance = 101;
      if (change === "fees")
        response.quoteRequest.appFees = [{ recipient: R, fee: 100 }];
      if (change === "quoteFees")
        response.quote.appFees = [{ recipient: R, fee: 1 }];
      if (change === "responseFees")
        response.appFees = [{ recipient: R, fee: 1 }];
      if (change === "feeBps") response.quoteRequest.feeBps = 1;
      if (change === "minimum") response.quote.minAmountOut = "1000001";
      if (change === "extraEffect")
        response.quoteRequest.customRecipientMsg = "changed";
      return response;
    };
    await assert.rejects(f.gateway.prepare(f.prepare));
  });
for (const change of [
  "signer",
  "debit",
  "asset",
  "receiver",
  "nonce",
  "duplicate",
  "extraIntent",
  "extraField",
] as const)
  test(`private funding rejects unsigned intent ${change}`, async () => {
    const f = fixture(),
      m: any = f.message;
    if (change === "signer") m.signer_id = R;
    if (change === "debit")
      m.intents[0].tokens[Object.keys(m.intents[0].tokens)[0]!] = "999999";
    if (change === "asset")
      m.intents[0].tokens = {
        ["imt:" + "a".repeat(64) + ":" + destination]: "1000000",
      };
    if (change === "receiver") m.intents[0].receiver_id = R;
    if (change === "nonce") m.nonce = "bad";
    if (change === "extraIntent") m.intents.push(m.intents[0]);
    if (change === "extraField") m.extra = "unexpected";
    if (change === "duplicate")
      f.providers.intent = async () => ({
        standard: "erc191",
        payload: JSON.stringify(m).replace(
          '"signer_id":',
          '"signer_id":"' + R + '","signer_id":',
        ),
      });
    await assert.rejects(f.gateway.prepare(f.prepare));
  });
for (const change of [
  "source",
  "destination",
  "recipient",
  "amount",
  "sender",
  "duplicate",
  "intentHash",
  "readAuth",
  "signedBytes",
  "receipt",
] as const)
  test(`private funding denies changed ${change} settlement evidence`, async () => {
    const f = fixture(),
      p = await f.gateway.prepare(f.prepare),
      row: any = f.successfulHistory(),
      input: any = f.status(p);
    f.history.push(row);
    if (change === "source") row.originAsset = destination;
    if (change === "destination") row.destinationAsset = source;
    if (change === "recipient") row.recipient = C;
    if (change === "amount") row.amountInFormatted = "1.01";
    if (change === "sender") row.quoteTransactions[0].sender = R;
    if (change === "duplicate") f.history.push(row);
    if (change === "intentHash") input.intentHash = "intent2";
    if (change === "readAuth") f.providers.authenticate = async () => R;
    if (change === "signedBytes") input.submittedIntent.payload += " ";
    if (change === "receipt")
      f.providers.confirm = async () => {
        throw Error("Noncanonical receipt");
      };
    await assert.rejects(f.gateway.status(input));
  });
test("private funding route never accepts destination overrides and returns private generic failures", async () => {
  const f = fixture(),
    register = (routes as any).registerConfidentialPrivateFundingRoutes;
  assert.equal(typeof register, "function");
  const app = Fastify({ logger: false });
  register(app, f.gateway);
  try {
    const success = await app.inject({
      method: "POST",
      url: "/v1/earn/native/private-funding/prepare",
      payload: f.prepare,
    });
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers["cache-control"], "no-store");
    for (const extra of [
      { destinationChainId: 143 },
      { destinationAsset: source },
      { destinationToken: C },
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/earn/native/private-funding/prepare",
        payload: { ...f.prepare, ...extra },
      });
      assert.equal(denied.statusCode, 400);
      assert.deepEqual(denied.json(), {
        code: "INVALID_PRIVATE_FUNDING_REQUEST",
      });
    }
    f.providers.authenticate = async () => {
      throw Error("secret account " + C);
    };
    const failed = await app.inject({
      method: "POST",
      url: "/v1/earn/native/private-funding/prepare",
      payload: f.prepare,
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(
      failed.json().code,
      "CONFIDENTIAL_PRIVATE_FUNDING_UNAVAILABLE",
    );
    assert.ok(!failed.body.includes(C));
  } finally {
    await app.close();
  }
});
test("private funding sealed route binding cannot be confused with Monad cashout metadata", async () => {
  const f = fixture(),
    p = await f.gateway.prepare(f.prepare);
  const envelope = new EarnRecoveryEnvelope("ab".repeat(32));
  const changed = { ...p, destinationChainId: 143, destinationAssetId: source };
  await assert.rejects(
    f.gateway.status({
      ...f.status(p),
      recoveryEnvelope: envelope.seal(
        "confidential-private-funding" as any,
        changed,
      ),
    }),
  );
});
test("private funding preparation never outlives its exact signer deadline", async () => {
  const f = fixture();
  f.message.deadline = new Date(at + 20000).toISOString();
  const p = await f.gateway.prepare(f.prepare);
  assert.equal(p.expiresAtMs, at + 20000);
});
test("private funding receipt commitments share the existing global event scope", async () => {
  const f = fixture(),
    p = await f.gateway.prepare(f.prepare);
  f.history.push(f.successfulHistory());
  await f.coordination.bind(
    "confidential-cashout-receipt",
    {
      chainId: 4663,
      token: p.destinationToken,
      transactionHash: tx,
      logIndex: 7,
    },
    { purpose: "another-payout", operationId: "previous" },
  );
  await assert.rejects(f.gateway.status(f.status(p)), /consumed/);
});
async function signedReadAndIntent() {
  const account = privateKeyToAccount(
    ("0x" + "00".repeat(31) + "01") as `0x${string}`,
  );
  const signer = account.address.toLowerCase();
  async function sign(payload: string) {
    const bytes = hexToBytes(await account.signMessage({ message: payload }));
    bytes[64]! -= 27;
    return {
      standard: "erc191",
      payload,
      signature: "secp256k1:" + base58.encode(bytes),
    };
  }
  const nonce = Buffer.alloc(32);
  Buffer.from("5628f6c600", "hex").copy(nonce);
  nonce.writeBigUInt64LE(BigInt(at + 300000) * 1000000n, 9);
  nonce.writeBigUInt64LE(BigInt(at) * 1000000n, 17);
  const read = await sign(
    JSON.stringify({
      deadline: new Date(at + 300000).toISOString(),
      intents: [],
      nonce: nonce.toString("base64"),
      signer_id: signer,
      verifying_contract: "intents.near",
    }),
  );
  return { signer, read, sign };
}
for (const receiptOnly of [false, true])
  for (const change of [
    "none",
    "wrongChain",
    "wrongToken",
    "wrongRecipient",
    "wrongAmount",
    "failedReceipt",
    "notFinal",
    "referenceReorg",
    "receiptReorg",
    "staleReceipt",
    "beforeReference",
    "duplicateTransfer",
    "transactionMismatch",
    "reorgAfter",
  ] as const)
    test(`${receiptOnly ? "cashout receipt" : "private funding"} production RPC verifies canonical finalized transfer: ${change}`, async (t) => {
      const f = fixture(),
        { signer, read, sign } = await signedReadAndIntent();
      const token = receiptOnly
        ? "0x754704bc059f8c67012fed69bc8a327a5aafb603"
        : "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
      const chainId = receiptOnly ? 143 : 4663;
      let prepared = false,
        receiptBlockReads = 0;
      const rpc = receiptOnly
        ? "https://rpc.monad.xyz/"
        : "https://private-funding-rpc.test/";
      t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
        const path = String(url),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        let result: any;
        if (path === rpc) {
          if (body.method === "eth_chainId")
            result = toHex(
              change === "wrongChain" && prepared
                ? receiptOnly
                  ? 4663
                  : 143
                : chainId,
            );
          else if (body.method === "eth_call") result = toHex(0n, { size: 32 });
          else if (body.method === "eth_getBlockByNumber") {
            const isReference =
              body.params[0] === "0x64" ||
              (!prepared && body.params[0] === "finalized");
            const isReceipt = body.params[0] === "0x65";
            if (isReceipt) receiptBlockReads++;
            result = {
              number: isReference
                ? "0x64"
                : isReceipt
                  ? "0x65"
                  : change === "notFinal"
                    ? "0x64"
                    : "0x66",
              hash:
                "0x" +
                (isReference
                  ? change === "referenceReorg" && prepared
                    ? "d"
                    : "a"
                  : isReceipt
                    ? change === "receiptReorg" ||
                      (change === "reorgAfter" && receiptBlockReads > 1)
                      ? "d"
                      : "c"
                    : "e"
                ).repeat(64),
              timestamp: toHex(
                BigInt(
                  (at - (change === "staleReceipt" && isReceipt ? 60000 : 0)) /
                    1000,
                ),
              ),
              transactions: [],
            };
          } else if (body.method === "eth_getTransactionReceipt") {
            const log = {
              address:
                change === "wrongToken"
                  ? receiptOnly
                    ? "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
                    : "0x754704bc059f8c67012fed69bc8a327a5aafb603"
                  : token,
              data: toHex(
                change === "wrongAmount"
                  ? receiptOnly
                    ? 979999n
                    : 989999n
                  : receiptOnly
                    ? 995012n
                    : 990000n,
                {
                  size: 32,
                },
              ),
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: {
                  from: C as `0x${string}`,
                  to: (change === "wrongRecipient"
                    ? signer
                    : R) as `0x${string}`,
                },
              }),
              transactionHash: tx,
              blockHash: "0x" + "c".repeat(64),
              blockNumber: "0x65",
              logIndex: "0x7",
              transactionIndex: "0x0",
              removed: false,
            };
            result = {
              transactionHash:
                change === "transactionMismatch" ? "0x" + "d".repeat(64) : tx,
              blockHash: "0x" + "c".repeat(64),
              blockNumber: change === "beforeReference" ? "0x64" : "0x65",
              status: change === "failedReceipt" ? "0x0" : "0x1",
              transactionIndex: "0x0",
              gasUsed: "0x1",
              cumulativeGasUsed: "0x1",
              effectiveGasPrice: "0x1",
              from: C,
              to: R,
              type: "0x2",
              logs:
                change === "duplicateTransfer"
                  ? [log, { ...log, logIndex: "0x8" }]
                  : [log],
            };
          } else throw Error("Unexpected RPC method " + body.method);
          return Response.json({ jsonrpc: "2.0", id: body.id, result });
        }
        if (path.includes("/auth/authenticate/"))
          result = { accessToken: "test-session" };
        else if (path.includes("/tokens/"))
          result = {
            tokens: [
              {
                blockchain: "monad",
                symbol: "USDC",
                decimals: 6,
                contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
                assetId: source,
              },
            ],
          };
        else if (path.includes("/account/balances/"))
          result = {
            balances: [
              { source: "private", tokenId: source, available: "3000000" },
            ],
          };
        else if (path.includes("/quote/"))
          result = await f.providers.quote(body);
        else if (path.includes("/status/")) result = { status: "SUCCESS" };
        else if (path.includes("/generate-intent/"))
          result = {
            intent: {
              standard: "erc191",
              payload: JSON.stringify({ ...f.message, signer_id: signer }),
            },
          };
        else if (path.includes("/account/history/") && receiptOnly)
          throw Error("History not allowed");
        else if (path.includes("/account/history/"))
          result = {
            items: [
              {
                ...f.successfulHistory(),
                refundTo: signer,
                quoteTransactions: [{ sender: signer, txHash: "intent1" }],
              },
            ],
          };
        else throw Error("Unexpected provider route");
        return Response.json(result);
      });
      const Gateway = receiptOnly
        ? gateways.ConfidentialCashoutGateway
        : (gateways as any).ConfidentialPrivateFundingGateway;
      const gateway = new Gateway(
        { ...f.config, auroraApiKey: "test-only", robinhoodRpcUrl: rpc },
        undefined,
        () => at,
      );
      const p = await gateway.prepare(
        { ...f.prepare, signedData: read },
        receiptOnly,
      );
      prepared = true;
      const input = {
        ...f.status(p),
        signedData: read,
        submittedIntent: await sign(p.intent.payload),
      };
      if (change === "none") {
        const paid = await gateway.status(input, receiptOnly);
        assert.equal(paid.status, "paid");
        if (receiptOnly) assert.equal(paid.receivedAtoms, "995012");
      } else await assert.rejects(gateway.status(input, receiptOnly));
    });
