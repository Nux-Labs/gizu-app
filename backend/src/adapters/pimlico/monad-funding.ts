import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { prepareUserOperationForErc20Paymaster } from "permissionless/experimental/pimlico";
import { createPublicClient, defineChain, erc20Abi, getAddress, http, type Address, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { entryPoint08Address, formatUserOperationRequest, toSimple7702SmartAccount } from "viem/account-abstraction";
import { fundingFeeCap, assertPaymasterValidity } from "../evm/gas-policy.ts";
import { estimateWithFreshPaymaster } from "../evm/token-paymaster.ts";
import { GasPolicyError, deterministicGasError } from "../evm/gas-errors.ts";
import { sourceFeeCap, stabilizeFundingApproval, validateFundingOperation } from "./source-funding.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";

export const MONAD_CHAIN_ID = 143;
export const MONAD_USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
export const MONAD_PAYMASTER = getAddress("0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402");
const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: "Monad Mainnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
});

export type UnsignedAuthorization = { chainId: number; address: Address; nonce: number };
export type PreparedFunding = {
  userOperation: Record<string, unknown>;
  authorization: UnsignedAuthorization | null;
  feeCapAtoms: string;
};
export type FundingReceipt = { found: false } | { found: true; success: boolean; transactionHash: Hex };

type Simple7702Owner = Parameters<typeof toSimple7702SmartAccount>[0]["owner"];

function watchOnly(address: Address): Simple7702Owner {
  const refuse = async (): Promise<never> => {
    throw new Error("The gateway never signs for a wallet");
  };
  return {
    ...toAccount({ address, signMessage: refuse, signTransaction: refuse, signTypedData: refuse }),
    sign: refuse,
    signAuthorization: refuse,
  } as Simple7702Owner;
}

// Mirrors the research `signedErc20FeeCap`; the phone recomputes it before signing.
export function signedErc20FeeCap(operation: {
  paymasterData?: Hex;
  preVerificationGas: bigint;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
  maxFeePerGas: bigint;
}): bigint {
  return fundingFeeCap({ ...operation, maxPriorityFeePerGas: 0n,
    paymasterPostOpGasLimit: operation.paymasterPostOpGasLimit ?? 0n,
    paymasterVerificationGasLimit: operation.paymasterVerificationGasLimit ?? 0n,
  }, MONAD_USDC, "swap");
}

export class PimlicoMonadFunding {
  private readonly rpc: string;
  private readonly client;

  constructor(private readonly key: string, monadRpc = "https://rpc.monad.xyz", private readonly now: () => number = Date.now) {
    this.rpc = `https://api.pimlico.io/v2/${MONAD_CHAIN_ID}/rpc?apikey=${encodeURIComponent(key)}`;
    this.client = createPublicClient({ chain: monad, transport: http(monadRpc, { timeout: 20_000 }), cacheTime: 0 });
  }

  async prepare(owner: Address, recipient: Address, amount: bigint): Promise<PreparedFunding> {
    return this.guard("prepare", async () => {
      if (await this.client.getChainId() !== MONAD_CHAIN_ID) throw new GasPolicyError("GAS_STATE_CHANGED", "Funding chain changed.");
      const block = await this.client.getBlock();
      const timestampMs = Number(block.timestamp) * 1000;
      if (!Number.isSafeInteger(timestampMs) || this.now() - timestampMs > 60000 || timestampMs - this.now() > 5000) throw new GasPolicyError("GAS_STATE_CHANGED", "Funding reference expired.");
      const pinned = { blockNumber: block.number };
      const [latest, pending, code, held, allowance, decimals, paymasterCode] = await Promise.all([
        this.client.getTransactionCount({ address: owner, ...pinned }), this.client.getTransactionCount({ address: owner, blockTag: "pending" }), this.client.getCode({ address: owner, ...pinned }),
        this.client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner], ...pinned }),
        this.client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "allowance", args: [owner, MONAD_PAYMASTER], ...pinned }),
        this.client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "decimals", ...pinned }), this.client.getCode({ address: MONAD_PAYMASTER, ...pinned }),
      ]);
      const account = await toSimple7702SmartAccount({ client: this.client, owner: watchOnly(owner) });
      const expectedCode = `0xef0100${account.authorization.address.slice(2)}`;
      if (latest !== pending || decimals !== 6 || !paymasterCode || paymasterCode === "0x" || (code && code !== "0x" && code.toLowerCase() !== expectedCode.toLowerCase())) throw new GasPolicyError("GAS_STATE_CHANGED", "Unsupported funding account state.");
      const pimlico = this.pimlico();
      const fees = (await pimlico.getUserOperationGasPrice()).standard;
      const bundler = createSmartAccountClient({
        account,
        client: this.client,
        chain: monad,
        bundlerTransport: http(this.rpc, { timeout: 30_000 }),
        paymaster: pimlico,
        userOperation: {
          estimateFeesPerGas: async () => fees,
          prepareUserOperation: prepareUserOperationForErc20Paymaster(pimlico),
        },
      });
      const initial = await bundler.prepareUserOperation({
        account,
        paymasterContext: { token: MONAD_USDC },
        calls: [{ to: MONAD_USDC, abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }],
      });
      // Swap keeps its existing SDK nonce lane. Bind and refresh that same lane.
      const nonceKey = initial.nonce >> 64n;
      const binding = { owner, recipient, amount, budget: held, allowance };
      const prepared = await stabilizeFundingApproval(initial, binding, calls => account.encodeCalls(calls), operation => estimateWithFreshPaymaster(operation,
        current => pimlico.estimateUserOperationGas({ ...current, account }),
        current => pimlico.getPaymasterData({ ...current, chainId: MONAD_CHAIN_ID, entryPointAddress: entryPoint08Address, context: { token: MONAD_USDC } }),
      ), "swap");
      if (!account.decodeCalls) throw new GasPolicyError("GAS_TERMS_CHANGED", "Funding call decoder unavailable.");
      validateFundingOperation(prepared, await account.decodeCalls(prepared.callData), binding, "swap");
      const [canonical, currentLatest, currentPending, currentCode, currentAllowance, currentBalance, currentNonce, currentFees] = await Promise.all([
        this.client.getBlock({ blockNumber: block.number }), this.client.getTransactionCount({ address: owner }), this.client.getTransactionCount({ address: owner, blockTag: "pending" }), this.client.getCode({ address: owner }),
        this.client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "allowance", args: [owner, MONAD_PAYMASTER] }), this.client.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        account.getNonce({ key: nonceKey }), pimlico.getUserOperationGasPrice(),
      ]);
      if (canonical.hash !== block.hash || currentLatest !== latest || currentPending !== latest || currentCode !== code || currentAllowance !== allowance || currentBalance !== held || currentNonce !== prepared.nonce || this.now() - timestampMs > 60000 || currentFees.standard.maxFeePerGas > prepared.maxFeePerGas || currentFees.standard.maxPriorityFeePerGas > prepared.maxPriorityFeePerGas) throw new GasPolicyError("GAS_STATE_CHANGED", "Funding state or fees changed during preparation.");
      if (prepared.authorization && (prepared.authorization.chainId !== MONAD_CHAIN_ID || prepared.authorization.nonce !== latest || prepared.authorization.address.toLowerCase() !== account.authorization.address.toLowerCase())) throw new GasPolicyError("GAS_STATE_CHANGED", "Funding authorization state changed.");
      if (sourceFeeCap(prepared, "swap") + amount > held) throw new GasPolicyError("GAS_BUDGET_EXCEEDED", "Funding amount and maximum fee exceed the current token balance.");
      try { assertPaymasterValidity(prepared.paymasterData, MONAD_USDC, BigInt(Math.floor(this.now() / 1000)), 30n); }
      catch { throw new GasPolicyError("GAS_TERMS_CHANGED", "Funding sponsorship expired or changed."); }
      const formatted = formatUserOperationRequest(prepared) as Record<string, unknown> & {
        eip7702Auth?: { chainId: Hex; address: Address; nonce: Hex };
      };
      const userOperation: Record<string, unknown> = {};
      for (const field of [
        "sender", "nonce", "factory", "factoryData", "callData", "callGasLimit",
        "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas",
        "paymaster", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit", "paymasterData",
      ]) {
        if (formatted[field] !== undefined) userOperation[field] = formatted[field];
      }
      return {
        userOperation,
        authorization: formatted.eip7702Auth
          ? { chainId: Number(formatted.eip7702Auth.chainId), address: getAddress(formatted.eip7702Auth.address), nonce: Number(formatted.eip7702Auth.nonce) }
          : null,
        feeCapAtoms: signedErc20FeeCap(prepared).toString(),
      };
    });
  }

  async submit(rpcOperation: Record<string, unknown>): Promise<Hex> {
    return this.guard("submit", async () => {
      const client = createPublicClient({ transport: http(this.rpc, { timeout: 30_000, retryCount: 0 }) });
      return client.request({
        method: "eth_sendUserOperation" as never,
        params: [rpcOperation, entryPoint08Address] as never,
      }) as Promise<Hex>;
    });
  }

  async receipt(hash: Hex): Promise<FundingReceipt> {
    return this.guard("receipt", async () => {
      const found = await this.pimlico().getUserOperationReceipt({ hash }).catch((error: { name?: string }) => {
        if (error.name === "UserOperationReceiptNotFoundError") return null;
        throw error;
      });
      if (!found) return { found: false } as const;
      return { found: true, success: found.success, transactionHash: found.receipt.transactionHash } as const;
    });
  }

  private pimlico() {
    return createPimlicoClient({
      chain: monad,
      transport: http(this.rpc, { timeout: 30_000 }),
      entryPoint: { address: entryPoint08Address, version: "0.8" },
    });
  }

  private async guard<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const gasError = deterministicGasError(error);
      if (gasError) throw gasError;
      if (error instanceof InfrastructureError) throw error;
      throw new InfrastructureError(502, "PIMLICO_FAILED", `Pimlico ${what} is unavailable. No fresh operation was authorized.`);
    }
  }
}
