import { createPublicClient, getAddress, http, keccak256, stringToHex, toHex, type Address } from "viem";
import { mainnet } from "viem/chains";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { readEthereumState, type EthereumPlannerConfig, type EthereumState } from "./ethereum-deposit-planner.ts";
import { feePolicy, nextBaseFee, type Fees } from "./policy.ts";
import { withPinnedFork, simulateForkSequence, type SimulationRow } from "./fork-simulation.ts";
import { balance, redeemCalls, ETHEREUM_PROFILE } from "./vault.ts";
import { mulDiv, nativeGasCost } from "../evm/gas-policy.ts";
type Providers={readState:(owner:Address)=>Promise<EthereumState>;assertFresh:(state:EthereumState,fees:Fees)=>Promise<void>;simulate:(state:EthereumState)=>Promise<SimulationRow[]>};
export type EthereumWithdrawalPlan={kind:"vaultRedeemAll";operationId:string;revision:number;chainId:1;profileId:"ethereum-usdc";owner:string;vault:string;token:string;router:string;amountAtoms:string;shareDecimals:number;nonce:string;deadline:string;referenceBlockNumber:string;referenceBlockHash:string;referenceTimestampMs:number;quotedAtMs:number;expiresAtMs:number;maxFeePerGasWei:string;priorityFeePerGasWei:string;gasLimits:string[];maximumGasCostWei:string;retainedAfterActionWei:"0";startingNativeWei:string;startingUsdc:string;startingShares:string;planHash:string;readOnly:true;executionAvailable:false;returnsQuoted:false;minimumAssetsGuard:false};
/** Called only for a separate withdrawal review. This module never broadcasts. */
export class EthereumWithdrawalPlanner {
  private providers:Providers;
  constructor(private config:EthereumPlannerConfig,providers?:Providers,private now:()=>number=Date.now) {
    if(providers){this.providers=providers;return;}
    const client=createPublicClient({chain:mainnet,transport:http(config.rpcUrl,{retryCount:0,timeout:12000}),cacheTime:0});
    this.providers={readState:owner=>readEthereumState(client,owner,now),simulate:async(state)=>{
      if(!config.anvilPath)throw new Error("Withdrawal simulation is not configured");
      return withPinnedFork({rpcUrl:config.rpcUrl,anvilPath:config.anvilPath,timeoutMs:config.timeoutMs,block:state.block},async(fork,signal)=>{
        signal.throwIfAborted();
        const rpc=(method:string,params:unknown[])=>fork.request({method,params} as never);
        if(await balance(fork,ETHEREUM_PROFILE.vault,getAddress(state.owner))!==state.shares)throw new Error("Position changed on fork");
        await rpc("anvil_impersonateAccount",[state.owner]);
        await rpc("anvil_setBalance",[state.owner,toHex(10n**24n)]);
        const rows=await simulateForkSequence(fork,getAddress(state.owner),await redeemCalls(fork,getAddress(state.owner),state.shares,state.block.timestamp+600n),signal);
        if(await balance(fork,ETHEREUM_PROFILE.vault,getAddress(state.owner))!==0n)throw new Error("Full fork exit left shares");
        return rows;
      });
    },assertFresh:async(state,fees)=>{
      const [fresh,canonical,pending]=await Promise.all([readEthereumState(client,getAddress(state.owner),now),client.getBlock({blockNumber:state.block.number}),client.getTransactionCount({address:getAddress(state.owner),blockTag:"pending"})]);
      if(canonical.hash!==state.block.hash||fresh.block.number>state.block.number+1n||BigInt(pending)!==state.nonce||nextBaseFee(fresh.block)+fees.priorityFee>fees.depositFee||["usdc","eth","weth","shares","nonce","shareAllowance"].some(key=>fresh[key as keyof EthereumState]!==state[key as keyof EthereumState]))throw new Error("Withdrawal state or fees changed");
    }};
  }
  async plan(request:{owner:string;operationId:string;revision:number}):Promise<EthereumWithdrawalPlan> {
    if(!/^0x[0-9a-f]{40}$/i.test(request.owner)||/^0x0{40}$/i.test(request.owner)||!/^[-a-zA-Z0-9_]{1,128}$/.test(request.operationId)||!Number.isSafeInteger(request.revision)||request.revision<1)throw new InfrastructureError(400,"INVALID_EARN_WITHDRAWAL","A wallet, withdrawal operation and revision are required.");
    try {
      const owner=getAddress(request.owner),state=await this.providers.readState(owner);
      if(state.owner.toLowerCase()!==owner.toLowerCase()||state.ownerCode!=="0x"||state.shares<=0n||state.weth!==0n)throw new Error("Position requires reconciliation");
      const fees=feePolicy(state.block,state.tips),rows=await this.providers.simulate(state);
      if(!rows.length||rows.length>2)throw new Error("Invalid full-exit simulation");
      const gasLimits=rows.map(row=>mulDiv(row.estimatedGas,130n,100n,"ceil"));
      const maximumGasCost=nativeGasCost(gasLimits.reduce((total,g)=>total+g,0n),fees.depositFee);
      if(state.eth<maximumGasCost)throw new Error("Withdrawal reserve does not cover current fees");
      await this.providers.assertFresh(state,fees);
      const quotedAtMs=this.now(),referenceTimestampMs=Number(state.block.timestamp)*1000;
      if(!Number.isSafeInteger(referenceTimestampMs)||quotedAtMs-referenceTimestampMs>60000||referenceTimestampMs-quotedAtMs>5000)throw new Error("Withdrawal plan expired");
      const plan:EthereumWithdrawalPlan={kind:"vaultRedeemAll",operationId:request.operationId,revision:request.revision,chainId:1,profileId:"ethereum-usdc",owner,vault:ETHEREUM_PROFILE.vault,token:ETHEREUM_PROFILE.usdc,router:ETHEREUM_PROFILE.router,amountAtoms:state.shares.toString(),shareDecimals:state.shareDecimals,nonce:state.nonce.toString(),deadline:(state.block.timestamp+600n).toString(),referenceBlockNumber:state.block.number.toString(),referenceBlockHash:state.block.hash,referenceTimestampMs,quotedAtMs,expiresAtMs:Math.min(quotedAtMs+45000,referenceTimestampMs+60000),maxFeePerGasWei:fees.depositFee.toString(),priorityFeePerGasWei:fees.priorityFee.toString(),gasLimits:gasLimits.map(String),maximumGasCostWei:maximumGasCost.toString(),retainedAfterActionWei:"0",startingNativeWei:state.eth.toString(),startingUsdc:state.usdc.toString(),startingShares:state.shares.toString(),planHash:"",readOnly:true,executionAvailable:false,returnsQuoted:false,minimumAssetsGuard:false};
      plan.planHash=keccak256(stringToHex(JSON.stringify(plan)));
      return Object.freeze({...plan,gasLimits:Object.freeze(plan.gasLimits) as unknown as string[]});
    }catch(error){if(error instanceof InfrastructureError)throw error;throw new InfrastructureError(502,"EARN_WITHDRAWAL_PLAN_UNAVAILABLE","Could not verify a fresh full withdrawal and current gas funding. Return fees need a later separate quote. No transaction was sent.");}
  }
}
