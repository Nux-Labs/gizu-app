import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, erc20Abi, parseAbi } from "viem";
import { PimlicoMonadFunding } from "../../../src/adapters/pimlico/monad-funding.ts";
import { entryPoint08Address } from "viem/account-abstraction";
import {
  MonadFundingPlanner,
  monadUsdc,
  tokenPaymaster,
} from "../../../src/adapters/pimlico/source-funding.ts";
const owner = "0x1000000000000000000000000000000000000001" as const,
  recipient = "0x2000000000000000000000000000000000000002" as const;
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const data = ("0x0200" +
  "00".repeat(12) +
  monadUsdc.slice(2) +
  "0".repeat(31) +
  "1" +
  (10n ** 18n + 1n).toString(16).padStart(64, "0") +
  "00".repeat(100)) as `0x${string}`;
const simpleAbi = parseAbi([
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
  "function execute(address target,uint256 value,bytes data)",
]);
function rpcMock(changedNonce = false, entryPointSequence = 0n, drift: "none" | "entrypoint" | "market" = "none", allowance = 0n) {
  const methods: string[] = [],
    sponsorOperations: any[] = [],
    nonceKeys: bigint[] = [];
  let estimates = 0,
    nonceReads = 0, entryPointReads = 0, marketReads = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const response = (request: any) => {
      const { method, params = [] } = request;
      methods.push(method);
      let result: unknown;
      switch (method) {
        case "eth_chainId":
          result = "0x8f";
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
        case "eth_call": {
          const selector = String(params[0].data).slice(0, 10);
          if (selector === "0x70a08231") result = word(1000n);
          else if (selector === "0x313ce567") result = word(6n);
          else if (selector === "0xdd62ed3e") result = word(allowance);
          else if (selector === "0x35567e1a") {
            const decoded = decodeFunctionData({
              abi: parseAbi([
                "function getNonce(address,uint192) view returns(uint256)",
              ]),
              data: params[0].data,
            });
            const key = decoded.args[1];
            nonceKeys.push(key);
            entryPointReads++;
            result = word((key << 64n) | (entryPointSequence + (drift === "entrypoint" && entryPointReads > 1 ? 1n : 0n)));
          } else throw new Error("Unexpected eth_call selector " + selector);
          break;
        }
        case "eth_supportedEntryPoints":
          result = [entryPoint08Address];
          break;
        case "pimlico_getTokenQuotes":
          result = {
            quotes: [
              {
                token: monadUsdc,
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
          marketReads++;
          result = Object.fromEntries(
            ["slow", "standard", "fast"].map((k) => [
              k,
              { maxFeePerGas: drift === "market" && marketReads > 1 ? "0x2" : "0x1", maxPriorityFeePerGas: "0x0" },
            ]),
          );
          break;
        case "pm_getPaymasterData":
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
    nonceKeys,
    get estimates() {
      return estimates;
    },
  };
}
test("full installed SDK unsigned source preparation supports cold 7702 and corrects floor approval", async (t) => {
  const mock = rpcMock();
  t.mock.method(globalThis, "fetch", mock.fetcher);
  const planner = new MonadFundingPlanner(
    "offline-secret",
    "https://offline-monad.invalid",
    () => 1000000,
  );
  let result: Awaited<ReturnType<typeof planner.prepare>>;
  try {
    result = await planner.prepare({
      owner,
      recipient,
      amount: "100",
      budget: "1000",
    });
  } catch (e) {
    t.diagnostic(JSON.stringify({ methods: mock.methods }));
    throw e;
  }
  assert.equal(result.authorizationRequired, true);
  assert.equal(result.authorizationNonce, "0");
  assert.equal(result.executionAvailable, false);
  assert.equal(result.paymasterDataStatus, "stub");
  assert.equal(result.operation.factory, "0x7702");
  assert.equal(result.operation.factoryData, "0x");
  assert.equal(result.feeCap, "8");
  const decoded = decodeFunctionData({
    abi: simpleAbi,
    data: result.operation.callData,
  });
  assert.equal(decoded.functionName, "executeBatch");
  if (decoded.functionName !== "executeBatch")
    throw new Error("Expected atomic call batch");
  const calls = decoded.args[0];
  assert.equal(calls.length, 2);
  const approval = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data }),
    transfer = decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data });
  assert.equal(approval.functionName, "approve");
  assert.deepEqual(approval.args, [tokenPaymaster, 8n]);
  assert.equal(transfer.functionName, "transfer");
  assert.deepEqual(transfer.args, [recipient, 100n]);
  assert.ok(mock.estimates >= 2);
  assert.ok(
    mock.methods.every((m) => !m.includes("send") && !m.includes("sign")),
  );
  assert.ok(
    mock.sponsorOperations.some((o) => {
      try {
        const c = decodeFunctionData({ abi: simpleAbi, data: o.callData });
        if (c.functionName !== "executeBatch") return false;
        const a = decodeFunctionData({
          abi: erc20Abi,
          data: c.args[0][0]!.data,
        });
        return a.functionName === "approve" && a.args[1] === 6n;
      } catch {
        return false;
      }
    }),
  );
  assert.ok(!JSON.stringify(result).includes("offline-secret"));
});
test("repeated unsigned funding previews retain native lane zero and its nonzero sequence", async (t) => {
  const mock = rpcMock(false, 7n);
  t.mock.method(globalThis, "fetch", mock.fetcher);
  const planner = new MonadFundingPlanner(
    "offline-secret",
    "https://offline-monad.invalid",
    () => 1000000,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await planner.prepare({
      owner,
      recipient,
      amount: "100",
      budget: "1000",
    });
    assert.equal(result.operation.nonce, "0x7");
    assert.equal(result.authorizationNonce, "0");
  }
  assert.ok(mock.nonceKeys.length >= 2);
  assert.ok(mock.nonceKeys.every((key) => key === 0n));
  assert.ok(
    mock.sponsorOperations.every((operation) => operation.nonce === "0x7"),
  );
  assert.ok(
    mock.methods.every(
      (method) => !method.includes("send") && !method.includes("sign"),
    ),
  );
});
test("full SDK source preparation rejects an EOA nonce change before returning approval", async (t) => {
  const mock = rpcMock(true);
  t.mock.method(globalThis, "fetch", mock.fetcher);
  const planner = new MonadFundingPlanner(
    "offline-secret",
    "https://offline-monad.invalid",
    () => 1000000,
  );
  await assert.rejects(
    planner.prepare({ owner, recipient, amount: "100", budget: "1000" }),
    { code: "GAS_STATE_CHANGED" },
  );
  assert.ok(
    mock.methods.every((m) => !m.includes("send") && !m.includes("sign")),
  );
});

for(const drift of ["entrypoint","market"] as const) test(`source rejects ${drift} drift independently of the EOA nonce`,async(t)=>{
 const mock=rpcMock(false,7n,drift);t.mock.method(globalThis,"fetch",mock.fetcher);
 const planner=new MonadFundingPlanner("offline-secret","https://offline-monad.invalid",()=>1000000);
 await assert.rejects(planner.prepare({owner,recipient,amount:"100",budget:"1000"}),{code:"GAS_STATE_CHANGED",statusCode:409});
 assert.ok(mock.methods.every(m=>!m.includes("send")&&!m.includes("sign")));
});

test("Swap estimates exact bounded approval and preserves its SDK nonce lane",async(t)=>{
 const mock=rpcMock(false,7n);t.mock.method(globalThis,"fetch",mock.fetcher);
 const planner=new PimlicoMonadFunding("offline-secret","https://offline-monad.invalid",()=>1000000);
 const result=await planner.prepare(owner,recipient,100n);
 const op=result.userOperation;const decoded=decodeFunctionData({abi:simpleAbi,data:op.callData as `0x${string}`});
 assert.equal(decoded.functionName,"executeBatch");if(decoded.functionName!=="executeBatch")throw Error("Expected bounded atomic batch");
 const approval=decodeFunctionData({abi:erc20Abi,data:decoded.args[0][0]!.data});assert.equal(approval.functionName,"approve");assert.equal(approval.args[1],7n);
 assert.equal(result.feeCapAtoms,"7");assert.ok(mock.estimates>=2);
 assert.ok(mock.nonceKeys.every(k=>k!==0n));assert.equal(BigInt(op.nonce as string)>>64n,mock.nonceKeys[0]);
 assert.ok(mock.methods.every(m=>!m.includes("send")&&!m.includes("sign")));
});
for(const drift of ["entrypoint","market"] as const) test(`Swap returns structured ${drift} drift failure`,async(t)=>{
 const mock=rpcMock(false,7n,drift);t.mock.method(globalThis,"fetch",mock.fetcher);
 await assert.rejects(new PimlicoMonadFunding("offline-secret","https://offline-monad.invalid",()=>1000000).prepare(owner,recipient,100n),{code:"GAS_STATE_CHANGED",statusCode:409,retryable:false});
});

import { readFileSync } from "node:fs";
test("Swap full-balance payload matches native protocol fee and approval bounds", async(t)=>{
 const vectors=JSON.parse(readFileSync(new URL("../../../../shared/gas-policy-v1.json",import.meta.url),"utf8"));
 const vector=vectors.balanceVectors.find((v:{name:string})=>v.name==="full-balance-fractional-swap");
 const mock=rpcMock(false,7n);t.mock.method(globalThis,"fetch",mock.fetcher);
 const result=await new PimlicoMonadFunding("offline-secret","https://offline-monad.invalid",()=>1000000).prepare(owner,recipient,BigInt(vector.principalAtoms));
 assert.equal(result.feeCapAtoms,vector.maximumFeeAtoms);
 const decoded=decodeFunctionData({abi:simpleAbi,data:result.userOperation.callData as `0x${string}`});
 assert.equal(decoded.functionName,"executeBatch");if(decoded.functionName!=="executeBatch")throw Error("Expected atomic funding batch");
 const approval=decodeFunctionData({abi:erc20Abi,data:decoded.args[0][0]!.data});
 const transfer=decodeFunctionData({abi:erc20Abi,data:decoded.args[0][1]!.data});
 assert.equal(approval.functionName,"approve");assert.equal(transfer.functionName,"transfer");
 const cap=BigInt(result.feeCapAtoms), approved=approval.args[1] as bigint;
 assert.equal(approved.toString(),vector.approvalAtoms);
 assert.ok(approved>=cap&&approved<=cap+cap/50n,"must satisfy existing native Swap upper bound");
 assert.equal(transfer.args[1].toString(),vector.principalAtoms);
 assert.equal(BigInt(vector.principalAtoms)+cap,BigInt(vector.balanceAtoms));
 assert.ok(mock.methods.every(m=>!m.includes("send")&&!m.includes("sign")));
});

test("Swap retains an existing allowance covering the protocol cap without a ceiling approval",async(t)=>{
 const mock=rpcMock(false,7n,"none",7n);t.mock.method(globalThis,"fetch",mock.fetcher);
 const result=await new PimlicoMonadFunding("offline-secret","https://offline-monad.invalid",()=>1000000).prepare(owner,recipient,993n);
 assert.equal(result.feeCapAtoms,"7");
 const decoded=decodeFunctionData({abi:simpleAbi,data:result.userOperation.callData as `0x${string}`});
 assert.equal(decoded.functionName,"execute");if(decoded.functionName!=="execute")throw Error("Existing allowance needs only the exact transfer");
 const transfer=decodeFunctionData({abi:erc20Abi,data:decoded.args[2]});assert.equal(transfer.functionName,"transfer");assert.equal(transfer.args[1],993n);
});
