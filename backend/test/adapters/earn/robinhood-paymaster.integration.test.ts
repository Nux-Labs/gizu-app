import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  createPublicClient,
  http,
} from "viem";
import { entryPoint08Address } from "viem/account-abstraction";
import { createRobinhoodPaymaster } from "../../../src/adapters/earn/robinhood-paymaster.ts";
import { createRobinhoodPlannerProviders } from "../../../src/adapters/earn/robinhood-deposit-planner.ts";
import {
  ROBINHOOD_PROFILE,
  robinhoodChain,
  robinhoodCalls,
} from "../../../src/adapters/earn/robinhood-vault.ts";
const usdg = ROBINHOOD_PROFILE.token,
  tokenPaymaster = ROBINHOOD_PROFILE.paymaster;
const owner = "0x1000000000000000000000000000000000000001" as const,
  recipient = "0x2000000000000000000000000000000000000002" as const;
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const data = ("0x0200" +
  "00".repeat(12) +
  usdg.slice(2) +
  "0".repeat(31) +
  "1" +
  (10n ** 18n + 1n).toString(16).padStart(64, "0") +
  "00".repeat(100)) as `0x${string}`;
const simpleAbi = parseAbi([
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
  "function execute(address target,uint256 value,bytes data)",
]);
function rpcMock(changedNonce = false) {
  const methods: string[] = [],
    sponsorOperations: any[] = [],
    estimateRequests: any[] = [];
  let estimates = 0,
    nonceReads = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const response = (request: any) => {
      const { method, params = [] } = request;
      methods.push(method);
      let result: unknown;
      switch (method) {
        case "eth_chainId":
          result = "0x1237";
          break;
        case "eth_getBlockByNumber":
          result = {
            number: "0x64",
            hash: "0x" + "a".repeat(64),
            parentHash: "0x" + "b".repeat(64),
            timestamp: "0x3e8",
            baseFeePerGas: "0x1",
            gasUsed: "0x1",
            gasLimit: "0x2",
            transactions: [],
            difficulty: "0x0",
            nonce: "0x0000000000000000",
            miner: "0x" + "0".repeat(40),
            extraData: "0x",
            size: "0x1",
            stateRoot: "0x" + "c".repeat(64),
            receiptsRoot: "0x" + "d".repeat(64),
            transactionsRoot: "0x" + "e".repeat(64),
            logsBloom: "0x" + "0".repeat(512),
            sha3Uncles: "0x" + "f".repeat(64),
            uncles: [],
          };
          break;
        case "eth_getCode":
          result =
            String(params[0]).toLowerCase() === owner.toLowerCase()
              ? "0x"
              : "0x6000";
          break;
        case "eth_getTransactionCount":
          nonceReads++;
          result = changedNonce && nonceReads >= 4 ? "0x1" : "0x0";
          break;
        case "eth_getBalance":
          result = "0x0";
          break;
        case "eth_call": {
          const selector = String(params[0].data).slice(0, 10);
          if (selector === "0x70a08231")
            result = word(
              String(params[0].to).toLowerCase() === usdg.toLowerCase()
                ? 1000n
                : 0n,
            );
          else if (selector === "0x38d52e0f")
            result = "0x" + "0".repeat(24) + usdg.slice(2);
          else if (selector === "0x313ce567") result = word(6n);
          else if (selector === "0xef8b30f7") result = word(100n);
          else if (selector === "0xdd62ed3e" || selector === "0x35567e1a")
            result = word(0n);
          else throw new Error("Unexpected eth_call selector " + selector);
          break;
        }
        case "eth_supportedEntryPoints":
          result = [entryPoint08Address];
          break;
        case "pimlico_getTokenQuotes":
          result = {
            quotes: [
              {
                token: usdg,
                paymaster: tokenPaymaster,
                postOpGas: "0x1",
                exchangeRate: "0x" + (10n ** 18n + 1n).toString(16),
                exchangeRateNativeToUsd: "0x1",
                balanceSlot: "0x9",
                allowanceSlot: "0xa",
              },
            ],
          };
          break;
        case "pimlico_getUserOperationGasPrice":
          result = Object.fromEntries(
            ["slow", "standard", "fast"].map((k) => [
              k,
              { maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x0" },
            ]),
          );
          break;
        case "pm_getPaymasterStubData":
          sponsorOperations.push(params[0]);
          result = {
            paymaster: tokenPaymaster,
            paymasterData: data,
            paymasterPostOpGasLimit: "0x1",
            paymasterVerificationGasLimit: "0x1",
            isFinal: true,
          };
          break;
        case "eth_estimateUserOperationGas":
          estimateRequests.push(params);
          estimates++;
          result = {
            callGasLimit: "0x1",
            preVerificationGas: estimates === 1 ? "0x1" : "0x2",
            verificationGasLimit: "0x1",
            paymasterPostOpGasLimit: "0x1",
            paymasterVerificationGasLimit: "0x1",
          };
          break;
        default:
          throw new Error("Unexpected RPC method " + method);
      }
      return { jsonrpc: "2.0", id: request.id, result };
    };
    return new Response(
      JSON.stringify(
        Array.isArray(payload) ? payload.map(response) : response(payload),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    fetcher,
    methods,
    sponsorOperations,
    estimateRequests,
    get estimates() {
      return estimates;
    },
  };
}
async function runtimeNonceFixture(
  t: TestContext,
  reply: (attempt: number) => { code: number; message: string } | bigint,
) {
  const mock = rpcMock();
  let nonceRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    const request = JSON.parse(String(init?.body));
    if (
      request.method === "eth_call" &&
      request.params[0].data.startsWith("0x35567e1a")
    ) {
      const result = reply(++nonceRequests);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          ...(typeof result === "bigint"
            ? { result: word(result) }
            : { error: result }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return mock.fetcher(url, init);
  });
  const providers = createRobinhoodPlannerProviders(
    { rpcUrl: "https://offline-hood.invalid", pimlicoApiKey: "offline-secret" },
    () => 1000000,
  );
  await providers.readState(owner);
  return { providers, mock, nonceRequests: () => nonceRequests };
}

test("runtime vault preparation recovers a throttled nonce in the same request and retains the real nonzero nonce", async (t) => {
  const f = await runtimeNonceFixture(t, (attempt) =>
    attempt <= 2
      ? {
          code: 429,
          message:
            "Your app has exceeded its compute units per second capacity",
        }
      : 9n,
  );
  const prepared = await f.providers.prepare(
    [{ to: recipient, data: "0x12", value: 0n }],
    { maxFeePerGas: 2n, maxPriorityFeePerGas: 0n },
  );
  assert.equal(prepared.operation.nonce, "0x9");
  assert.equal(f.nonceRequests(), 4);
  assert.ok(
    f.mock.methods.every(
      (method) => !method.includes("send") && !method.includes("sign"),
    ),
  );
});

test("persistent nonce throttling is bounded and cannot fabricate a zero nonce or start sponsorship", async (t) => {
  const f = await runtimeNonceFixture(t, () => ({
    code: 429,
    message: "provider capacity",
  }));
  await assert.rejects(
    f.providers.prepare([{ to: recipient, data: "0x12", value: 0n }], {
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 0n,
    }),
  );
  assert.equal(f.nonceRequests(), 4);
  assert.equal(f.mock.sponsorOperations.length, 0);
  assert.equal(f.mock.estimateRequests.length, 0);
});

test("nonce drift after throttling recovers still invalidates the prepared operation", async (t) => {
  const f = await runtimeNonceFixture(t, (attempt) =>
    attempt <= 2
      ? { code: 429, message: "provider capacity" }
      : attempt === 3
        ? 9n
        : 10n,
  );
  await assert.rejects(
    f.providers.prepare([{ to: recipient, data: "0x12", value: 0n }], {
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 0n,
    }),
    /Pending Robinhood nonce/,
  );
  assert.equal(f.nonceRequests(), 4);
});

test("a deterministic nonce contract revert is rejected immediately without sponsorship or nonce fallback", async (t) => {
  const f = await runtimeNonceFixture(t, () => ({
    code: 3,
    message: "execution reverted",
  }));
  await assert.rejects(
    f.providers.prepare([{ to: recipient, data: "0x12", value: 0n }], {
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 0n,
    }),
  );
  assert.equal(f.nonceRequests(), 1);
  assert.equal(f.mock.sponsorOperations.length, 0);
});
test("installed Robinhood SDK threads verified storage overrides and corrects token approval ceiling", async (t) => {
  const mock = rpcMock();
  t.mock.method(globalThis, "fetch", mock.fetcher);
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http("https://offline-hood.invalid", { retryCount: 0 }),
  });
  const provider = await createRobinhoodPaymaster(
    client,
    owner,
    "offline-secret",
  );
  const calls = (await robinhoodCalls(client, owner, "deposit", 500000n, 2000n))
    .calls;
  const slot = ("0x" + "a".repeat(64)) as `0x${string}`,
    value = ("0x" + "b".repeat(64)) as `0x${string}`;
  const result = await provider.prepare(
    calls,
    { maxFeePerGas: 2n, maxPriorityFeePerGas: 0n },
    [{ address: usdg, stateDiff: [{ slot, value }] }],
  );
  assert.equal(result.feeCap, 15n);
  assert.equal(result.operation.factory, "0x7702");
  assert.ok(mock.estimates >= 3);
  assert.ok(
    mock.estimateRequests.every(
      (params) =>
        JSON.stringify(params[2]).includes(slot) &&
        !JSON.stringify(params[2]).includes("balance"),
    ),
  );
  const decoded = decodeFunctionData({
    abi: simpleAbi,
    data: result.operation.callData,
  });
  assert.equal(decoded.functionName, "executeBatch");
  if (decoded.functionName !== "executeBatch")
    throw new Error("Expected account batch");
  const approval = decodeFunctionData({
    abi: erc20Abi,
    data: decoded.args[0][0]!.data,
  });
  assert.equal(approval.functionName, "approve");
  assert.deepEqual(approval.args, [tokenPaymaster, 16n]);
  assert.equal(decoded.args[0].length, 3);
  assert.ok(
    mock.methods.every((m) => !m.includes("send") && !m.includes("sign")),
  );
  assert.ok(!JSON.stringify(result.operation).includes("offline-secret"));
});

test("parallel SDK preparations retain their own calldata and state overrides without submitting", async (t) => {
  const mock = rpcMock();
  t.mock.method(globalThis, "fetch", mock.fetcher);
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http("https://offline-hood.invalid", { retryCount: 0 }),
  });
  const provider = await createRobinhoodPaymaster(
    client,
    owner,
    "offline-secret",
  );
  const amounts = [500000n, 750000n];
  const calls = await Promise.all(
    amounts.map(
      async (amount) =>
        (await robinhoodCalls(client, owner, "deposit", amount, 2000n)).calls,
    ),
  );
  const overrides = amounts.map((_, i) => [
    {
      address: usdg,
      stateDiff: [
        {
          slot: ("0x" + String(i + 1).repeat(64)) as `0x${string}`,
          value: ("0x" + "a".repeat(64)) as `0x${string}`,
        },
      ],
    },
  ]);
  const results = await Promise.all(
    calls.map((batch, i) =>
      provider.prepare(
        batch,
        { maxFeePerGas: 2n, maxPriorityFeePerGas: 0n },
        overrides[i],
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const decoded = decodeFunctionData({
      abi: simpleAbi,
      data: results[i]!.operation.callData,
    });
    assert.equal(decoded.functionName, "executeBatch");
    if (decoded.functionName !== "executeBatch")
      throw new Error("Expected batch");
    assert.deepEqual(
      decoded.args[0].slice(-calls[i]!.length).map((c) => c.data),
      calls[i]!.map((c) => c.data),
    );
    const estimates = mock.estimateRequests.filter(
      (params) => params[0].callData === results[i]!.operation.callData,
    );
    assert.ok(estimates.length > 0);
    assert.ok(
      estimates.every((params) =>
        JSON.stringify(params[2]).includes(
          overrides[i]![0]!.stateDiff[0]!.slot,
        ),
      ),
    );
    assert.equal(results[i]!.operation.nonce, "0x0");
  }
  assert.ok(
    mock.methods.every((m) => !m.includes("send") && !m.includes("sign")),
  );
});
