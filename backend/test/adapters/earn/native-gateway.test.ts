import test from "node:test";
import Fastify from "fastify";
import { registerEarnNativeRoutes } from "../../../src/http/routes/earn-native.routes.ts";
import assert from "node:assert/strict";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import {
  NativeEarnGateway,
  parseAuroraFeeQualification,
} from "../../../src/adapters/earn/native-gateway.ts";
const now = Date.parse("2026-09-30T10:00:00Z");
const owner = "0x1000000000000000000000000000000000000001",
  confidential = "0x2000000000000000000000000000000000000002",
  recipient = "0x3000000000000000000000000000000000000003";
const input = {
  settlementMode: "balance-delta-v1" as const,
  operationId: "operation-1",
  revision: 1,
  profileChainId: 4663 as const,
  sourceOwner: owner,
  confidentialAccount: confidential,
  amountAtoms: "1000000",
};
const binding = (quote: any) =>
  Object.fromEntries(
    [
      "operationId",
      "revision",
      "quoteId",
      "chainId",
      "token",
      "amountAtoms",
      "confidentialAccount",
      "refundOwner",
      "recipient",
    ].map((k) => [k, quote[k]]),
  ) as any;
const config = {
  protocolFeeBps: 2 as const,
  appFees: [{ recipient: "qualified.near", fee: 2 as const }],
  referral: null,
};
function provider(mutator?: (body: any) => void) {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.match(
      String(url),
      /^https:\/\/intents-api\.aurora\.dev\/api\/quote\//,
    );
    const request = JSON.parse(String(init?.body));
    assert.equal(request.dry, false);
    const body = {
      timestamp: new Date(now).toISOString(),
      signature: "provider-signed-quote",
      quoteRequest: { ...request, appFees: config.appFees, referral: null },
      quote: {
        depositAddress: recipient,
        amountIn: input.amountAtoms,
        minAmountIn: input.amountAtoms,
        amountOut: "999800",
        minAmountOut: "999800",
        deadline: request.deadline,
        timeWhenInactive: request.deadline,
        refundFee: "0",
        withdrawFee: "0",
      },
    };
    mutator?.(body);
    return new Response(JSON.stringify(body));
  };
  return {
    fetcher,
    get calls() {
      return calls;
    },
  };
}
test("fee policy must be explicitly qualified and strict", () => {
  assert.deepEqual(parseAuroraFeeQualification(JSON.stringify(config)), config);
  assert.throws(() =>
    parseAuroraFeeQualification('{"protocolFeeBps":0,"appFees":[]}'),
  );
  assert.throws(() =>
    parseAuroraFeeQualification(JSON.stringify({ ...config, unknown: true })),
  );
  assert.throws(() =>
    parseAuroraFeeQualification(
      JSON.stringify({
        ...config,
        appFees: [{ recipient: "integrator.near", fee: 4 }],
      }),
    ),
  );
  assert.throws(() =>
    parseAuroraFeeQualification(
      JSON.stringify({ ...config, referral: "gizu" }),
    ),
  );
  assert.throws(() =>
    parseAuroraFeeQualification(JSON.stringify({ ...config, appFees: [] })),
  );
});
test("executable source quote is immutable, provider bound, and idempotent", async () => {
  const p = provider();
  const gateway = new NativeEarnGateway(
    { auroraHistoryQualified: true, auroraApiKey: "server-only", auroraFeeQualification: config, recoveryKey: "11".repeat(32) },
    { fetcher: p.fetcher, now: () => now },
  );
  const quote = await gateway.sourceQuote(input);
  assert.equal(quote.chainId, 143);
  assert.equal(quote.recipient, recipient);
  assert.equal(quote.minimumCreditAtoms, "999800");
  assert.ok(Object.isFrozen(quote));
  assert.equal(
    (await gateway.sourceQuote({ ...input })).quoteId,
    quote.quoteId,
  );
  assert.equal(p.calls, 1);
  assert.deepEqual(gateway.quoteBinding(binding(quote)), quote);
  const settlement = gateway.verifiedQuoteForSettlement(
    input.operationId,
    input.revision,
    quote.quoteId,
  );
  assert.equal(settlement.quoteCreatedAt, now / 1000);
  assert.equal(settlement.refundOwner, owner);
  await assert.rejects(
    gateway.sourceQuote({ ...input, amountAtoms: "1000001" }),
  );
  assert.throws(() => new NativeEarnGateway({}).quoteBinding(binding(quote)));
});
test("changed recipient, input, refund, fees and inactive quote fail closed", async () => {
  for (const mutate of [
    (v: any) => (v.quoteRequest.recipient = owner),
    (v: any) => (v.quote.amountIn = "999999"),
    (v: any) => (v.quoteRequest.refundTo = recipient),
    (v: any) => (v.quoteRequest.appFees = []),
    (v: any) => (v.quote.deadline = new Date(now - 1).toISOString()),
    (v: any) => (v.quote.depositMemo = "hostile"),
  ]) {
    const p = provider(mutate);
    await assert.rejects(
      new NativeEarnGateway(
        { auroraHistoryQualified: true, auroraApiKey: "key", auroraFeeQualification: config, recoveryKey: "11".repeat(32) },
        { fetcher: p.fetcher, now: () => now },
      ).sourceQuote(input),
    );
  }
});
test("expired quote cannot fund but remains available for authenticated settlement", async () => {
  let clock = now;
  const p = provider();
  const g = new NativeEarnGateway(
    { auroraHistoryQualified: true, auroraApiKey: "key", auroraFeeQualification: config, recoveryKey: "11".repeat(32) },
    { fetcher: p.fetcher, now: () => clock },
  );
  const quote = await g.sourceQuote(input);
  clock += 601000;
  assert.throws(() => g.quoteBinding(binding(quote)));
  assert.equal(
    g.verifiedQuoteForSettlement(input.operationId, 1, quote.quoteId).recipient,
    recipient,
  );
});
test("return quote uses exact supported chain and asset registry", async () => {
  const p = provider();
  const g = new NativeEarnGateway(
    { auroraHistoryQualified: true, auroraApiKey: "key", auroraFeeQualification: config, recoveryKey: "11".repeat(32) },
    { fetcher: p.fetcher, now: () => now },
  );
  assert.equal((await g.returnQuote(input)).chainId, 4663);
  const eth = await new NativeEarnGateway(
    { auroraHistoryQualified: true, auroraApiKey: "key", auroraFeeQualification: config, recoveryKey: "11".repeat(32) },
    { fetcher: p.fetcher, now: () => now },
  ).returnQuote({
    ...input,
    operationId: "ethereum-return",
    profileChainId: 1,
    returnAsset: "native",
  });
  assert.equal(eth.chainId, 1);
  assert.equal(
    eth.token.toLowerCase(),
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  );
});
test("bundler rejects unsigned send, arbitrary methods, credentials and wrong chain without network", async () => {
  let count = 0;
  const g = new NativeEarnGateway(
    { pimlicoApiKey: "secret" },
    {
      fetcher: async () => {
        count++;
        throw new Error("must not fetch");
      },
    },
  );
  for (const req of [
    { jsonrpc: "2.0", id: 1, method: "eth_sign", params: [] },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendUserOperation",
      params: [
        { signature: "0x" },
        "0x0000000000000000000000000000000000000000",
      ],
    },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_supportedEntryPoints",
      params: [],
      apikey: "clientkey",
    },
  ])
    await assert.rejects(g.bundler(143, req));
  await assert.rejects(
    g.bundler(1, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_supportedEntryPoints",
      params: [],
    }),
  );
  assert.equal(count, 0);
});
test("bounded bundler provider failure never returns credentials or raw error", async () => {
  const g = new NativeEarnGateway(
    { pimlicoApiKey: "secret-key" },
    {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            error: { code: -32000, message: "secret-key https://credentials" },
          }),
        ),
    },
  );
  const r = await g.bundler(143, {
    jsonrpc: "2.0",
    id: 7,
    method: "eth_supportedEntryPoints",
    params: [],
  });
  assert.equal(JSON.stringify(r).includes("secret-key"), false);
  assert.equal((r as any).error.message, "Bundler unavailable.");
});

// Public zero-entropy test key; signatures are created offline and never sent live.
import { privateKeyToAccount } from "viem/accounts";
import {
  entryPoint08Address,
  getUserOperationTypedData,
  getUserOperationHash,
} from "viem/account-abstraction";
import { toHex } from "viem";
import type { Address, Hex } from "viem";
import type { UserOperation } from "viem/account-abstraction";
import {
  monadUsdc,
  tokenPaymaster,
} from "../../../src/adapters/pimlico/source-funding.ts";
const testAccount = privateKeyToAccount(("0x" + "00".repeat(31) + "01") as Hex);
const delegate = "0xe6Cae83BdE06E4c305530e199D7217f42808555B" as Address;
function unsignedOperation() {
  const data =
    "0x03" +
    "00" +
    BigInt(now / 1000 + 300)
      .toString(16)
      .padStart(12, "0") +
    "00".repeat(6) +
    monadUsdc.slice(2).toLowerCase() +
    100n.toString(16).padStart(32, "0") +
    (10n ** 18n).toString(16).padStart(64, "0") +
    "00".repeat(100);
  return {
    sender: testAccount.address,
    nonce: "0x0",
    callData: "0x12345678",
    callGasLimit: "0x64",
    verificationGasLimit: "0x64",
    preVerificationGas: "0x64",
    maxFeePerGas: "0x2",
    maxPriorityFeePerGas: "0x1",
    paymaster: tokenPaymaster,
    paymasterData: data,
    paymasterVerificationGasLimit: "0x64",
    paymasterPostOpGasLimit: "0x64",
    signature: "0x",
  };
}
async function signedOperation(cold: boolean, includeFactory = true) {
  const op = unsignedOperation();
  const signedAuth = await testAccount.signAuthorization({
    chainId: 143,
    address: delegate,
    nonce: 0,
  });
  const authorization = cold
    ? signedAuth
    : includeFactory
      ? { address: delegate }
      : undefined;
  const factory = includeFactory
    ? { factory: "0x7702", factoryData: "0x" }
    : {};
  const typed = {
    ...op,
    ...Object.fromEntries(
      [
        "nonce",
        "callGasLimit",
        "verificationGasLimit",
        "preVerificationGas",
        "maxFeePerGas",
        "maxPriorityFeePerGas",
        "paymasterVerificationGasLimit",
        "paymasterPostOpGasLimit",
      ].map((k) => [k, BigInt(op[k as keyof typeof op])]),
    ),
    ...factory,
    ...(authorization ? { authorization } : {}),
  } as unknown as UserOperation<"0.8">;
  const signature = await testAccount.signTypedData(
    getUserOperationTypedData({
      chainId: 143,
      entryPointAddress: entryPoint08Address,
      userOperation: typed,
    }),
  );
  const outgoing = {
    ...op,
    ...factory,
    signature,
    ...(cold
      ? {
          eip7702Auth: {
            chainId: "0x8f",
            address: delegate,
            nonce: "0x0",
            r: signedAuth.r,
            s: signedAuth.s,
            yParity: signedAuth.yParity === 0 ? "0x00" : "0x01",
          },
        }
      : {}),
  };
  const expected = getUserOperationHash({
    chainId: 143,
    entryPointAddress: entryPoint08Address,
    entryPointVersion: "0.8",
    userOperation: typed,
  });
  return { outgoing, expected };
}
test("native signed cold and already delegated 7702 operations forward exact JSON and validate returned hash", async () => {
  for (const cold of [false, true]) {
    const { outgoing, expected } = await signedOperation(cold);
    let count = 0;
    const gateway = new NativeEarnGateway(
      { pimlicoApiKey: "server-key" },
      {
        now: () => now,
        fetcher: async (url, init) => {
          count++;
          assert.equal(
            String(url),
            "https://api.pimlico.io/v2/143/rpc?apikey=server-key",
          );
          assert.deepEqual(JSON.parse(String(init?.body)).params, [
            outgoing,
            entryPoint08Address,
          ]);
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: expected }),
          );
        },
      },
    );
    const response = await gateway.bundler(143, {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendUserOperation",
      params: [outgoing, entryPoint08Address],
    });
    assert.equal(response.result, expected);
    assert.equal(count, 1);
    await assert.rejects(
      gateway.bundler(143, {
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendUserOperation",
        params: [{ ...outgoing, maxFeePerGas: "0x3" }, entryPoint08Address],
      }),
    );
    assert.equal(count, 1);
  }
});
test("final sponsorship uses a simulation signature and preserves estimated gas when provider omits it", async () => {
  const op = unsignedOperation();
  const snapshot = JSON.stringify(op);
  const stub =
    "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
  let forwarded = false;
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "key" },
    {
      now: () => now,
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        assert.deepEqual(request.params[0], { ...op, signature: stub });
        forwarded = true;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: {
              paymaster: tokenPaymaster,
              paymasterData: op.paymasterData,
            },
          }),
        );
      },
    },
  );
  const response = await gateway.bundler(143, {
    jsonrpc: "2.0",
    id: 3,
    method: "pm_getPaymasterData",
    params: [op, entryPoint08Address, "0x8f", { token: monadUsdc }],
  });
  assert.equal(forwarded, true);
  assert.deepEqual(response.result, {
    paymaster: tokenPaymaster,
    paymasterData: op.paymasterData,
    paymasterPostOpGasLimit: op.paymasterPostOpGasLimit,
    paymasterVerificationGasLimit: op.paymasterVerificationGasLimit,
  });
  assert.equal(JSON.stringify(op), snapshot);
  await assert.rejects(
    gateway.bundler(143, {
      jsonrpc: "2.0",
      id: 4,
      method: "eth_sendUserOperation",
      params: [{ ...op, signature: stub }, entryPoint08Address],
    }),
  );
});
test("unsigned final paymaster request pins token and canonical quantities, including five gas terms", async () => {
  const op = unsignedOperation();
  let count = 0;
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "key" },
    {
      now: () => now,
      fetcher: async () => {
        count++;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: {
              paymaster: tokenPaymaster,
              paymasterData: op.paymasterData,
              paymasterPostOpGasLimit: "0x64",
              paymasterVerificationGasLimit: "0x64",
              isFinal: true,
            },
          }),
        );
      },
    },
  );
  const req = {
    jsonrpc: "2.0",
    id: 3,
    method: "pm_getPaymasterData",
    params: [op, entryPoint08Address, "0x8f", { token: monadUsdc }],
  };
  assert.equal((await gateway.bundler(143, req)).result !== undefined, true);
  for (const changed of [
    { ...op, verificationGasLimit: "0x00" },
    { ...op, paymasterPostOpGasLimit: "0x0" },
    { ...op, maxFeePerGas: toHex(1n << 128n) },
    {
      ...op,
      paymasterData: op.paymasterData.replace(
        monadUsdc.slice(2).toLowerCase(),
        "00".repeat(20),
      ),
    },
    { ...op, signature: "0x" + "ff".repeat(65) },
  ])
    await assert.rejects(
      gateway.bundler(143, {
        ...req,
        params: [changed, entryPoint08Address, "0x8f", { token: monadUsdc }],
      }),
    );
  assert.equal(count, 1);
});
test("provider response size and concurrency are bounded", async () => {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_supportedEntryPoints",
    params: [],
  };
  const oversized = new NativeEarnGateway(
    { pimlicoApiKey: "key" },
    { fetcher: async () => new Response("x".repeat(262145)) },
  );
  assert.ok((await oversized.bundler(143, request)).error);
  let finish: () => void = () => {};
  const blocker = new Promise<void>((r) => (finish = r));
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "key" },
    {
      fetcher: async () => {
        await blocker;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: [entryPoint08Address],
          }),
        );
      },
    },
  );
  const pending = Array.from({ length: 4 }, () =>
    gateway.bundler(143, request),
  );
  await assert.rejects(gateway.bundler(143, request), /EARN_NATIVE_RATE_LIMIT/);
  finish();
  await Promise.all(pending);
});
test("historical receipts and ByHash return bounded verified fields without provider extras", async () => {
  const { outgoing, expected } = await signedOperation(true);
  let clock = now + 3600000;
  const providerReceipt = {
    userOpHash: expected,
    entryPoint: entryPoint08Address,
    sender: testAccount.address,
    nonce: "0x0",
    paymaster: tokenPaymaster,
    actualGasCost: "0x2",
    actualGasUsed: "0x1",
    success: true,
    receipt: {
      transactionHash: "0x" + "11".repeat(32),
      blockHash: "0x" + "22".repeat(32),
      blockNumber: "0x1",
      secret: "server-key",
    },
    secret: "server-key",
  };
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "server-key" },
    {
      now: () => clock,
      fetcher: async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result:
              req.method === "eth_getUserOperationByHash"
                ? {
                    entryPoint: entryPoint08Address,
                    userOperation: outgoing,
                    blockNumber: "0x1",
                    blockHash: "0x" + "22".repeat(32),
                    transactionHash: "0x" + "11".repeat(32),
                    secret: "server-key",
                  }
                : providerReceipt,
          }),
        );
      },
    },
  );
  for (const method of [
    "eth_getUserOperationReceipt",
    "eth_getUserOperationByHash",
  ]) {
    const r = await gateway.bundler(143, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: [expected],
    });
    assert.ok(r.result);
    assert.equal(JSON.stringify(r).includes("server-key"), false);
  }
  clock = now;
});
test("ByHash normalizes absent provider factory fields without changing submitted operation validation", async () => {
  const { outgoing, expected } = await signedOperation(false, false);
  let operation: Record<string, unknown> = {
    ...outgoing,
    factory: null,
    factoryData: null,
  };
  let calls = 0;
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "server-key" },
    {
      now: () => now + 3600000,
      fetcher: async (_url, init) => {
        calls++;
        const request = JSON.parse(String(init?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { entryPoint: entryPoint08Address, userOperation: operation },
        });
      },
    },
  );
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getUserOperationByHash",
    params: [expected],
  };
  const result = await gateway.bundler(143, request);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    (result.result as { userOperation: object }).userOperation,
    outgoing,
  );
  for (const changed of [
    { ...outgoing, factory: null, factoryData: "0x" },
    { ...outgoing, factory: "0x7702", factoryData: null },
    { ...outgoing, factory: null, factoryData: null, nonce: "0x1" },
    { ...outgoing, factory: null, factoryData: null, paymasterData: null },
  ]) {
    operation = changed;
    assert.ok((await gateway.bundler(143, request)).error);
  }
  const previousCalls = calls;
  await assert.rejects(
    gateway.bundler(143, {
      ...request,
      method: "eth_sendUserOperation",
      params: [
        { ...outgoing, factory: null, factoryData: null },
        entryPoint08Address,
      ],
    }),
  );
  assert.equal(calls, previousCalls);
});

test("ByHash accepts provider numeric 7702 authorization fields and returns hex quantities", async () => {
  const { outgoing, expected } = await signedOperation(true);
  const auth = outgoing.eip7702Auth!;
  // Pimlico's live ByHash shape: chainId, nonce and yParity are JSON numbers.
  const userOperation = {
    ...outgoing,
    eip7702Auth: {
      ...auth,
      chainId: 143,
      nonce: 0,
      yParity: Number(BigInt(auth.yParity)),
    },
  };
  const gateway = new NativeEarnGateway(
    { pimlicoApiKey: "server-key" },
    {
      now: () => now + 3600000,
      fetcher: async (_url, init) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(String(init?.body)).id,
            result: {
              entryPoint: entryPoint08Address,
              userOperation,
              blockNumber: "0x1",
              blockHash: "0x" + "22".repeat(32),
              transactionHash: "0x" + "11".repeat(32),
            },
          }),
        ),
    },
  );
  const r = await gateway.bundler(143, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getUserOperationByHash",
    params: [expected],
  });
  assert.equal(r.error, undefined);
  const returned = (r.result as { userOperation: { eip7702Auth: object } })
    .userOperation.eip7702Auth;
  // Byte-identical to the signed record, so already installed native builds match it.
  assert.deepEqual(returned, auth);
  for (const changed of [{ chainId: 1 }, { nonce: -1 }, { yParity: 2 }]) {
    const rejected = new NativeEarnGateway(
      { pimlicoApiKey: "server-key" },
      {
        now: () => now + 3600000,
        fetcher: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                entryPoint: entryPoint08Address,
                userOperation: {
                  ...userOperation,
                  eip7702Auth: { ...userOperation.eip7702Auth, ...changed },
                },
              },
            }),
          ),
      },
    );
    assert.ok(
      (
        await rejected.bundler(143, {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getUserOperationByHash",
          params: [expected],
        })
      ).error,
    );
  }
});

test("source and return original quotes recover after restart without provider requote", async () => {
  for (const kind of ["source", "return"] as const) {
    const p = provider();
    const cfg = { auroraHistoryQualified: true, auroraApiKey: "server-only", auroraFeeQualification: config, recoveryKey: "11".repeat(32) };
    const first = new NativeEarnGateway(cfg, {fetcher:p.fetcher,now:()=>now});
    const quote = await (kind === "source" ? first.sourceQuote(input) : first.returnQuote(input));
    assert.equal(typeof quote.recoveryEnvelope, "string");
    const restart = new NativeEarnGateway(cfg, {fetcher:p.fetcher,now:()=>now});
    const exact = {...binding(quote), recoveryEnvelope:quote.recoveryEnvelope};
    assert.deepEqual(restart.quoteBinding(exact), quote);
    assert.equal(p.calls, 1);
    assert.deepEqual(await (kind === "source" ? restart.sourceQuote(input) : restart.returnQuote(input)), quote);
    for (const change of [{amountAtoms:"1"},{revision:2},{recipient:owner},{quoteId:"0x"+"00".repeat(32)}])
      assert.throws(()=>new NativeEarnGateway(cfg,{now:()=>now}).quoteBinding({...exact,...change}));
    assert.throws(()=>new NativeEarnGateway({...cfg,recoveryKey:"22".repeat(32)},{now:()=>now}).quoteBinding(exact));
    assert.throws(()=>restart.quoteBinding({...exact,recoveryEnvelope:quote.recoveryEnvelope!.slice(0,-1)+"!"}));
    assert.throws(()=>new NativeEarnGateway(cfg,{now:()=>now+601000}).quoteBinding(exact));
    assert.equal(p.calls,1);
  }
});
test("recovered envelope cannot replace an already bound different quote", async()=>{
  const cfg = { auroraHistoryQualified: true, auroraApiKey:"key", auroraFeeQualification:config,recoveryKey:"11".repeat(32) };
  const a = new NativeEarnGateway(cfg,{fetcher:provider().fetcher,now:()=>now});
  const q = await a.sourceQuote(input);
  const b = new NativeEarnGateway(cfg,{fetcher:provider(v=>v.quote.depositAddress=owner.replace(/1$/, "4")).fetcher,now:()=>now});
  await b.sourceQuote(input);
  assert.throws(()=>b.quoteBinding({...binding(q),recoveryEnvelope:q.recoveryEnvelope}));
});

test("recovery preserves valid provider timestamp skew and fails closed without durable key",async()=>{
  const cfg = {auroraHistoryQualified: true, auroraApiKey:"key",auroraFeeQualification:config,recoveryKey:"11".repeat(32)};
  for (const skew of [-60000,60000]) {
    const g = new NativeEarnGateway(cfg,{now:()=>now,fetcher:provider(v=>v.timestamp=new Date(now+skew).toISOString()).fetcher});
    const q = await g.sourceQuote(input);
    assert.deepEqual(new NativeEarnGateway(cfg,{now:()=>now}).quoteBinding({...binding(q),recoveryEnvelope:q.recoveryEnvelope}),q);
  }
  const p = provider();
  await assert.rejects(new NativeEarnGateway({auroraHistoryQualified: true, auroraApiKey:"key",auroraFeeQualification:config},{fetcher:p.fetcher,now:()=>now}).sourceQuote(input),/EARN_RECOVERY_UNAVAILABLE/);
  assert.equal(p.calls,0);
});

test("restart recovery binding accepts actual sealed quote through bounded HTTP route", async()=>{
  const cfg = {auroraHistoryQualified: true, auroraApiKey:"key",auroraFeeQualification:config,recoveryKey:"11".repeat(32)};
  const q = await new NativeEarnGateway(cfg,{fetcher:provider().fetcher,now:()=>now}).sourceQuote(input);
  const payload = {...binding(q),recoveryEnvelope:q.recoveryEnvelope};
  assert.ok(JSON.stringify(payload).length>2048);
  const app = Fastify({logger:false});
  registerEarnNativeRoutes(app,new NativeEarnGateway(cfg,{now:()=>now}));
  const result = await app.inject({method:"POST",url:"/v1/earn/native/quote-binding",payload});
  assert.equal(result.statusCode,200);
  assert.deepEqual(result.json(),q);
  assert.equal(result.headers["cache-control"],"no-store");
  const oversized = await app.inject({method:"POST",url:"/v1/earn/native/quote-binding",payload:{recoveryEnvelope:"s".repeat(196609)}});
  assert.equal(oversized.statusCode,413);
  assert.equal(oversized.body.includes("ssss"),false);
  await app.close();
});

test("dry preview displays fees without qualification and cannot create a signing binding", async () => {
  let dry = false;
  const gateway = new NativeEarnGateway({auroraApiKey:"key",recoveryKey:"11".repeat(32)}, {now:()=>now, fetcher:async (_url, init)=>{
    const request = JSON.parse(String(init?.body)); dry = request.dry;
    return new Response(JSON.stringify({quoteRequest:{...request,appFees:[{recipient:"observed.near",fee:4}],referral:"observed"},quote:{amountIn:request.amount,minAmountIn:request.amount,amountOut:"999600",minAmountOut:"999600",deadline:request.deadline}}));
  }});
  const preview = await gateway.sourcePreview(input);
  assert.equal(dry,true);
  assert.equal(preview.executionAvailable,false);
  assert.equal(preview.minimumCreditAtoms,"999600");
  assert.equal(preview.providerFeeBps,4);
  assert.deepEqual(preview.blockers,["EARN_AURORA_FEE_UNQUALIFIED"]);
  assert.equal("quoteId" in preview,false);
  await assert.rejects(gateway.sourceQuote(input), {code:"EARN_AURORA_FEE_UNQUALIFIED"});
});
test("dry source quotes omit executable deadlines without inventing a signing binding", async () => {
  const gateway = new NativeEarnGateway({auroraApiKey:"key"}, {
    now:()=>now,
    fetcher:async(_url,init)=>{
      const request=JSON.parse(String(init?.body));
      assert.equal(request.dry,true);
      return Response.json({timestamp:new Date(now).toISOString(),quoteRequest:{...request,appFees:[]},quote:{amountIn:request.amount,minAmountIn:request.amount,amountOut:request.amount,minAmountOut:request.amount}});
    },
  });
  const preview=await gateway.sourcePreview(input);
  assert.equal(preview.quoteAvailable,true);
  assert.equal(preview.executionAvailable,false);
  assert.equal(preview.expiresAtMs,now+60000);
  assert.equal("quoteId" in preview,false);
  assert.equal("depositAddress" in preview,false);
  await assert.rejects(gateway.sourceQuote(input),/EARN_AURORA_FEE_UNQUALIFIED/);
});
test("new funding does not require invitation-only history qualification", async () => {
  const p=provider();
  const gateway=new NativeEarnGateway({auroraApiKey:"key",auroraFeeQualification:config,recoveryKey:"11".repeat(32)},{now:()=>now,fetcher:p.fetcher});
  const quote=await gateway.sourceQuote(input);
  assert.equal(quote.maximumCreditAtoms, "999800");
  assert.equal(p.calls,1);
});

test("firm variable fees and policy version survive recovery without a second provider quote", async()=>{
  const fees={version:"qualified-4bps",routes:{source:{collectors:[{recipient:"qualified.near",maximumBps:4}],maximumTotalBps:4,referral:"qualified-referral",integratorFeeBps:0 as const,applicationFeeAtoms:"0" as const,qualificationReference:"verified-key-record"}}};
  const completeFees={...fees,routes:{...fees.routes,payoutRobinhood:fees.routes.source,returnRobinhood:fees.routes.source,withdrawal:fees.routes.source}};
  const p=provider(body=>{body.quoteRequest.appFees=[{recipient:"qualified.near",fee:4}];body.quoteRequest.referral="qualified-referral";body.quote.amountOut="999600";body.quote.minAmountOut="999600";});
  const cfg={auroraHistoryQualified:true,auroraApiKey:"server-key",auroraFeeQualification:completeFees,recoveryKey:"11".repeat(32)};
  const q=await new NativeEarnGateway(cfg,{fetcher:p.fetcher,now:()=>now}).sourceQuote(input);
  assert.equal(q.providerFeeBps,4);assert.equal(q.feePolicy?.version,"qualified-4bps");
  assert.deepEqual(new NativeEarnGateway(cfg,{now:()=>now}).quoteBinding({...binding(q),recoveryEnvelope:q.recoveryEnvelope}),q);
  assert.equal(p.calls,1);
});

test("partial route qualification cannot fund a profile with unqualified payouts or returns", async()=>{
 const source={collectors:[{recipient:"qualified.near",maximumBps:4}],maximumTotalBps:4,referral:null,integratorFeeBps:0 as const,applicationFeeAtoms:"0" as const,qualificationReference:"verified-record"};
 const p=provider();
 const g=new NativeEarnGateway({auroraHistoryQualified:true,auroraApiKey:"key",recoveryKey:"11".repeat(32),auroraFeeQualification:{version:"partial",routes:{source}}},{fetcher:p.fetcher,now:()=>now});
 await assert.rejects(g.sourceQuote(input),{code:"EARN_AURORA_FEE_UNQUALIFIED"});
 assert.equal(p.calls,0);
});

test("preview accepts provider-normalized EVM address case while preserving route identity",async()=>{
 const normalizedInput={...input,sourceOwner:"0x069b3c1DD949E01504DD6Ac0a9729b730Cc87A4E",confidentialAccount:"0x1A899cBD5cae6988e9f98BDD00007898037F2D00"};
 const g=new NativeEarnGateway({auroraApiKey:"key"},{now:()=>now,fetcher:async(_url,init)=>{const request=JSON.parse(String(init?.body));return new Response(JSON.stringify({quoteRequest:{...request,recipient:request.recipient.toLowerCase(),refundTo:request.refundTo.toLowerCase(),appFees:[{recipient:"provider.near",fee:4}]},quote:{amountIn:request.amount,minAmountIn:request.amount,amountOut:"999600",minAmountOut:"999600",deadline:request.deadline}}));}});
 assert.equal((await g.sourcePreview(normalizedInput)).minimumCreditAtoms,"999600");
});

test("a provider-disabled route still reports qualification blockers without invented fees or credit",async()=>{
 const g=new NativeEarnGateway({auroraApiKey:"key"},{now:()=>now,fetcher:async()=>new Response(JSON.stringify({message:"Quoting for this pair is not available"}),{status:400})});
 const preview=await g.sourcePreview(input);
 assert.equal(preview.quoteAvailable,false);
 assert.equal(preview.minimumCreditAtoms,null);
 assert.equal(preview.providerFeeBps,null);
 assert.deepEqual(preview.blockers,["EARN_AURORA_FEE_UNQUALIFIED","EARN_RECOVERY_UNAVAILABLE","EARN_AURORA_ROUTE_UNAVAILABLE"]);
 assert.equal("quoteId" in preview,false);
});

test("outdated clients cannot receive new executable funding routes without baseline support", async () => {
 const p=provider();
 const gateway=new NativeEarnGateway({auroraApiKey:"key",auroraFeeQualification:config,recoveryKey:"11".repeat(32)},{now:()=>now,fetcher:p.fetcher});
 await assert.rejects(gateway.sourceQuote({...input,settlementMode:undefined}),{code:"EARN_NATIVE_UPGRADE_REQUIRED"});
 await assert.rejects(gateway.returnQuote({...input,settlementMode:undefined}),{code:"EARN_NATIVE_UPGRADE_REQUIRED"});
 assert.equal(p.calls,0);
});

test("an unsigned recovered legacy quote cannot bypass snapshot admission through quote-binding", async () => {
  const p=provider(),key="11".repeat(32),cfg={auroraApiKey:"key",auroraFeeQualification:config,recoveryKey:key};
  const quote=await new NativeEarnGateway(cfg,{now:()=>now,fetcher:p.fetcher}).sourceQuote(input);
  const codec=new EarnRecoveryEnvelope(key),saved=codec.open("native-quote",quote.recoveryEnvelope!) as any;
  delete saved.quote.maximumCreditAtoms;delete saved.settlement.maximumCreditAtoms;
  const envelope=codec.seal("native-quote",saved);
  const gateway=new NativeEarnGateway(cfg,{now:()=>now,fetcher:p.fetcher});
  assert.throws(()=>gateway.quoteBinding({...binding(quote),recoveryEnvelope:envelope}),{code:"EARN_NATIVE_UPGRADE_REQUIRED"});
});

test('replicas claim signed bundler authority once and preserve receipt recovery',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  const rows=new Map<string,string>();const store={async bind(key:string,value:string,_expires:number,exclusive:boolean){const old=rows.get(key);if(old)return !exclusive&&old===value;rows.set(key,value);return true;}};
  const coordination=new OperationCoordinator(store,'ab'.repeat(32));const {outgoing,expected}=await signedOperation(true);let sends=0;
  const fetcher:typeof fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.method==='eth_sendUserOperation')sends++;return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:expected}));};
  const config={pimlicoApiKey:'server-only',coordination};
  const req={jsonrpc:'2.0',id:1,method:'eth_sendUserOperation',params:[outgoing,entryPoint08Address]};
  await Promise.allSettled([new NativeEarnGateway(config,{fetcher,now:()=>now}).bundler(143,req),new NativeEarnGateway(config,{fetcher,now:()=>now}).bundler(143,req)]);
  await Promise.allSettled([new NativeEarnGateway(config,{fetcher,now:()=>now}).bundler(143,req)]);
  assert.equal(sends,1);
});
test('shared source quote issuance cannot change operation binding on a second replica',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  const rows=new Map<string,string>();const store={async bind(key:string,value:string,_expires:number,exclusive:boolean){const old=rows.get(key);if(old)return !exclusive&&old===value;rows.set(key,value);return true;}};
  const coordination=new OperationCoordinator(store,'ab'.repeat(32)),p=provider();
  const cfg={auroraHistoryQualified:true,auroraApiKey:'server-only',auroraFeeQualification:config,recoveryKey:'11'.repeat(32),coordination};
  const first=new NativeEarnGateway(cfg,{fetcher:p.fetcher,now:()=>now}),quote=await first.sourceQuote(input);
  const second=new NativeEarnGateway(cfg,{fetcher:p.fetcher,now:()=>now});
  await assert.rejects(second.sourceQuote({...input,amountAtoms:'2000000'}));
  assert.equal((await second.sourceQuote({...input,recoveryEnvelope:quote.recoveryEnvelope})).quoteId,quote.quoteId);
  assert.equal(p.calls,1);
});
