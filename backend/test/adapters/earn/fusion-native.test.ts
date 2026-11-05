import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, hashTypedData } from "viem";
import { FusionNativeGateway } from "../../../src/adapters/earn/fusion-native.ts";
const owner=privateKeyToAccount('0x'+'01'.repeat(32) as `0x${string}`);
const confidentialAccount='0x0000000000000000000000000000000000000002';
const router='0x111111125421ca6dc452d289314280a0f8842a65';
const usdc='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const now=Date.now(),deadline=BigInt(Math.floor(now/1000)+250);
const request={operationId:'fusion_test',revision:1,owner:owner.address,confidentialAccount,inputAtoms:'2000000',resolverGasPriceWei:'10000',minimumEthWei:'100',maximumResolverOverheadWei:'10000'};
const order={salt:'1',maker:owner.address,receiver:owner.address,makerAsset:usdc,takerAsset:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',makingAmount:'2000000',takingAmount:'200',makerTraits:'0'};
function gateway(){return new FusionNativeGateway({apiKey:'server-only',recoveryKey:'ab'.repeat(32)}, {now:()=>now,readFunding:async()=>({balance:2000000n,allowance:2000000n,permitNonce:4n}),quote:async(_owner,_input,_gas,options)=>({input:2000000n,minimumEth:150n,grossEth:200n,deadline:options?.deadline??deadline,quoteId:options?.enableEstimate?'provider-quote':null,quotedAtMs:now,expiresAtMs:now+60000,orderHash:'0x'+'aa'.repeat(32),extension:'0x1234',unsignedOrder:order,priceUsdcPerEth:1n,economics:{estimatedGas:1n,gasUnits:2n,gasPrice:3n,gasCostWei:6n,profitWei:1n,allowanceWei:7n,inputValueWei:1000n,maximumGrossEth:993n}}),fetcher:async()=>new Response('{}')});}
test('native Fusion preview binds economics but cannot submit',async()=>{const g=gateway();const p=await g.quote(request);assert.equal(p.executable,false);assert.equal(p.resolverGasCostWei,'6');assert.equal(p.extensionHash,keccak256('0x1234'));assert.equal(g.binding({operationId:request.operationId,revision:1,quoteId:p.quoteId}).owner,owner.address);await assert.rejects(g.submit({operationId:request.operationId,revision:1,quoteId:p.quoteId,order,extension:'0x1234',signature:'0x'+'11'.repeat(65)}));assert.throws(()=>g.binding({operationId:'other',revision:1,quoteId:p.quoteId}));});
test('executable Fusion accepts only the current exact native USDC permit and preserves its deadline',async()=>{const g=gateway();const signature=await owner.signTypedData({domain:{name:'USD Coin',version:'2',chainId:1,verifyingContract:usdc},types:{Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]},primaryType:'Permit',message:{owner:owner.address,spender:router,value:2000000n,nonce:4n,deadline}});const r=('0x'+signature.slice(2,66))as `0x${string}`,s=('0x'+signature.slice(66,130))as `0x${string}`,v=Number.parseInt(signature.slice(130),16);const permitData=encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint8'},{type:'bytes32'},{type:'bytes32'}],[owner.address,router,2000000n,deadline,v,r,s]);const p=await g.quote({...request,executionRequested:true,permitData});assert.equal(p.executable,true);assert.equal(p.deadline,deadline.toString());await assert.rejects(g.quote({...request,revision:2,executionRequested:true,permitData:permitData.slice(0,-2)+(Number.parseInt(permitData.slice(-2),16)^1).toString(16).padStart(2,'0')}));await assert.rejects(g.quote({...request,revision:2,minimumEthWei:'151'}));});

const orderTyped={domain:{name:'1inch Aggregation Router',version:'6',chainId:1,verifyingContract:router as `0x${string}`},types:{Order:[{name:'salt',type:'uint256'},{name:'maker',type:'address'},{name:'receiver',type:'address'},{name:'makerAsset',type:'address'},{name:'takerAsset',type:'address'},{name:'makingAmount',type:'uint256'},{name:'takingAmount',type:'uint256'},{name:'makerTraits',type:'uint256'}]},primaryType:'Order' as const,message:{...order,maker:owner.address,receiver:owner.address,makerAsset:usdc as `0x${string}`,takerAsset:order.takerAsset as `0x${string}`,salt:1n,makingAmount:2000000n,takingAmount:200n,makerTraits:0n}};
test('encrypted native Fusion quote survives server restart and retries only exact signed authority',async()=>{
  let clock=now, sends=0;
  const providers={now:()=>clock,readFunding:async()=>({balance:2000000n,allowance:2000000n,permitNonce:4n}),quote:async()=>({input:2000000n,minimumEth:150n,grossEth:200n,deadline,quoteId:'provider-quote',quotedAtMs:now,expiresAtMs:now+60000,orderHash:hashTypedData(orderTyped),extension:'0x1234',unsignedOrder:order,priceUsdcPerEth:1n,economics:{estimatedGas:1n,gasUnits:2n,gasPrice:3n,gasCostWei:6n,profitWei:1n,allowanceWei:7n,inputValueWei:1000n,maximumGrossEth:993n}}),fetcher:async()=>{sends++; if(sends===1)throw new Error('lost response');return new Response('{}');}};
  const config={apiKey:'server-only',recoveryKey:'ab'.repeat(32)};
  const first=new FusionNativeGateway(config,providers), proof=await first.quote({...request,executionRequested:true});
  assert.ok(proof.recoveryEnvelope);
  const signature=await owner.signTypedData(orderTyped), signed={operationId:request.operationId,revision:1,quoteId:proof.quoteId,order,extension:'0x1234',signature,recoveryEnvelope:proof.recoveryEnvelope};
  await assert.rejects(first.submit(signed));
  clock=now+61000;
  const restarted=new FusionNativeGateway(config,providers);
  assert.equal((await restarted.submit(signed)).orderHash,proof.orderHash);assert.equal(sends,2);
  await assert.rejects(restarted.submit({...signed,order:{...order,takingAmount:'201'}}));
  await assert.rejects(restarted.submit({...signed,operationId:'different'}));
  const wrong=new FusionNativeGateway({...config,recoveryKey:'cd'.repeat(32)},providers);
  await assert.rejects(wrong.submit(signed));
  clock=Number(deadline)*1000+1;await assert.rejects(restarted.submit(signed));assert.equal(sends,2);
});

test('shared coordination prevents duplicate Fusion sends across replicas and after uncertain transport',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  const rows=new Map<string,string>();
  const store={async bind(key:string,value:string,_expires:number,exclusive:boolean){const old=rows.get(key);if(old)return !exclusive&&old===value;rows.set(key,value);return true;}};
  const coordination=new OperationCoordinator(store,'ab'.repeat(32));let sends=0;
  const providers={now:()=>now,readFunding:async()=>({balance:2000000n,allowance:2000000n,permitNonce:4n}),quote:async()=>({input:2000000n,minimumEth:150n,grossEth:200n,deadline,quoteId:'provider-quote',quotedAtMs:now,expiresAtMs:now+60000,orderHash:hashTypedData(orderTyped),extension:'0x1234',unsignedOrder:order,priceUsdcPerEth:1n,economics:{estimatedGas:1n,gasUnits:2n,gasPrice:3n,gasCostWei:6n,profitWei:1n,allowanceWei:7n,inputValueWei:1000n,maximumGrossEth:993n}}),fetcher:async()=>{sends++;throw new Error('lost response');}};
  const config={apiKey:'server-only',recoveryKey:'ab'.repeat(32),coordination};
  const first=new FusionNativeGateway(config,providers),proof=await first.quote({...request,executionRequested:true});
  const signed={operationId:request.operationId,revision:1,quoteId:proof.quoteId,order,extension:'0x1234',signature:await owner.signTypedData(orderTyped),recoveryEnvelope:proof.recoveryEnvelope};
  await Promise.allSettled([first.submit(signed),new FusionNativeGateway(config,providers).submit(signed)]);
  await assert.rejects(new FusionNativeGateway(config,providers).submit(signed));
  assert.equal(sends,1,'only the first durable claim may send signed authority');
});
