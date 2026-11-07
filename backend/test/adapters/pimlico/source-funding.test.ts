import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi } from "viem";
import { sourceFeeCap, validateFundingOperation, stabilizeFundingApproval, type FundingOperation } from "../../../src/adapters/pimlico/source-funding.ts";
const token = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const owner = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const paymaster = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402" as const;
function fixture() {
  const data = "0x0200" + "00".repeat(12) + token.slice(2) + "0".repeat(31) + "1" + (10n ** 18n + 1n).toString(16).padStart(64,"0") + "00".repeat(100);
  const operation = { sender: owner, paymaster, nonce: 0n, callData: "0x1234" as `0x${string}`, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, callGasLimit: 1n, preVerificationGas: 1n, verificationGasLimit: 1n, paymasterPostOpGasLimit: 1n, paymasterVerificationGasLimit: 1n, paymasterData: data as `0x${string}` };
  const calls = [{to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[paymaster,7n]})}, {to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[recipient,100n]})}];
  return { operation, calls, binding: {owner,recipient,amount:100n,budget:107n,allowance:0n} };
}
test("source cap rounds all five gas terms plus provider post-op term upward", () => {
  assert.equal(sourceFeeCap(fixture().operation),7n);
});
test("funding validation binds exactly one USDC transfer and narrowly bounded paymaster approval", () => {
  const f=fixture();
  assert.equal(validateFundingOperation(f.operation,f.calls,f.binding),7n);
  assert.equal(validateFundingOperation({...f.operation,factory:"0x7702",factoryData:"0x"},f.calls,f.binding),7n);
  assert.throws(()=>validateFundingOperation(f.operation,f.calls,{...f.binding,budget:106n}));
  assert.throws(()=>validateFundingOperation(f.operation,f.calls,{...f.binding,recipient:owner}));
  assert.throws(()=>validateFundingOperation(f.operation,[...f.calls,f.calls[1]!],f.binding));
  assert.throws(()=>validateFundingOperation({...f.operation,sender:recipient},f.calls,f.binding));
  assert.throws(()=>validateFundingOperation({...f.operation,paymaster:recipient},f.calls,f.binding));
  assert.throws(()=>validateFundingOperation({...f.operation,factory:recipient},f.calls,f.binding));
  assert.throws(()=>validateFundingOperation(f.operation,[{...f.calls[0]!,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[paymaster,(1n<<256n)-1n]})},f.calls[1]!],f.binding));
  assert.throws(()=>validateFundingOperation(f.operation,[{...f.calls[1]!,value:1n}],{...f.binding,allowance:7n}));
  assert.throws(()=>validateFundingOperation(f.operation,[{...f.calls[1]!,data:f.calls[1]!.data+"00" as `0x${string}`}],{...f.binding,allowance:7n}));
  assert.equal(validateFundingOperation(f.operation,[f.calls[1]!],{...f.binding,allowance:7n}),7n);
  assert.throws(()=>validateFundingOperation(f.operation,[f.calls[1]!],{...f.binding,allowance:6n}));
});
test("unsupported paymaster flags, tokens, rates, missing gas and oversized data fail closed", () => {
  const f=fixture();
  for(const change of [
    {paymasterData:"0x04"+f.operation.paymasterData.slice(4)},
    {paymasterData:"0x0201"+f.operation.paymasterData.slice(6)},
    {paymasterData:f.operation.paymasterData.replace(token.slice(2),recipient.slice(2))},
    {paymasterData:"0x02"},
    {paymasterData:f.operation.paymasterData+"00".repeat(4096)},
    {verificationGasLimit:undefined},
    {maxFeePerGas:0n},
    {maxPriorityFeePerGas:2n},
    {nonce:-1n},
  ]) assert.throws(()=>sourceFeeCap({...f.operation,...change} as FundingOperation));
});

test("SDK floor approval is rebuilt and re-estimated until the conservative ceiling fits", async () => {
  const f=fixture();
  let encoded=f.calls;
  let estimates=0;
  const binding={...f.binding,budget:108n};
  const op=await stabilizeFundingApproval(f.operation,binding,async(calls)=>{
    encoded=calls as typeof encoded;
    return "0x1234";
  },async(operation)=>{
    estimates++;
    return {...operation,preVerificationGas:2n};
  });
  assert.ok(estimates>=1);
  assert.equal(sourceFeeCap(op),8n);
  assert.equal(validateFundingOperation(op,encoded,binding),8n);
  // Changed estimated cap still fits only when the budget includes it.
  await assert.rejects(stabilizeFundingApproval(f.operation,{...f.binding,budget:106n},async()=>"0x1234",async(op)=>op));
});

test("flow-specific final validation keeps Swap protocol fees separate from Earn ceilings",()=>{
 const f=fixture(),operation={...f.operation,preVerificationGas:2n};
 const binding={...f.binding,amount:993n,budget:1000n,allowance:7n};
 const transfer={to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[recipient,993n]})};
 assert.equal(sourceFeeCap(operation,"swap"),7n);assert.equal(sourceFeeCap(operation),8n);
 assert.equal(validateFundingOperation(operation,[transfer],binding,"swap"),7n);
 assert.throws(()=>validateFundingOperation(operation,[transfer],binding));
 const approval={to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:"approve",args:[paymaster,8n]})};
 assert.throws(()=>validateFundingOperation(operation,[approval,transfer],{...binding,allowance:0n},"swap"),/approval/);
});
