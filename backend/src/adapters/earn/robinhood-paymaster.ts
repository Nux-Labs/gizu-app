import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  toHex,
} from "viem";
import type { Address, Hex, PublicClient, StateOverride } from "viem";
import {
  entryPoint08Address,
  toSimple7702SmartAccount,
  formatUserOperationRequest,
} from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { prepareUserOperationForErc20Paymaster } from "permissionless/experimental/pimlico";
import { ROBINHOOD_PROFILE, robinhoodChain } from "./robinhood-vault.ts";
import type { ExactCall } from "./vault.ts";
import { gasFields, erc20PaymasterCap, assertPaymasterValidity, uint256, mulDiv } from "../evm/gas-policy.ts";
import { stabilizePaymasterApproval, estimateWithFreshPaymaster } from "../evm/token-paymaster.ts";
export type RobinhoodOperation = Partial<
  Record<(typeof gasFields)[number], bigint>
> & {
  sender: Address;
  paymaster?: Address;
  paymasterData?: Hex;
  nonce: bigint;
  callData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  factory?: Address;
  factoryData?: Hex;
};
const uint = uint256;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function robinhoodTokenCap(op: RobinhoodOperation): bigint {
  return erc20PaymasterCap(op, { token: ROBINHOOD_PROFILE.token, rounding: "ceil" });
}
export async function stabilizeRobinhoodApproval<T extends RobinhoodOperation>(
  initial: T,
  calls: ExactCall[],
  allowance: bigint,
  encode: (calls: ExactCall[]) => Promise<Hex>,
  estimate: (operation: T) => Promise<T>,
): Promise<T> {
  return stabilizePaymasterApproval({ initial, calls, allowance, token: ROBINHOOD_PROFILE.token,
    paymaster: ROBINHOOD_PROFILE.paymaster, cap: robinhoodTokenCap, encode: allowed => encode(allowed.map(c => ({ ...c, data: c.data ?? "0x" }))), estimate });
}
export type RobinhoodFeePrice = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};
export type RobinhoodPrepared = {
  operation: ReturnType<typeof formatUserOperationRequest>;
  feeCap: bigint;
  fees: RobinhoodFeePrice;
  delegation: Address;
  authorizationRequired: boolean;
  authorizationNonce: number;
  expiresAtMs?: number;
};
export async function createRobinhoodPaymaster(
  client: PublicClient,
  owner: Address,
  key: string,
) {
  if (!key || (await client.getChainId()) !== 4663)
    throw new Error("USDG paymaster unavailable");
  const refuse = async (): Promise<never> => {
    throw new Error("Read-only USDG preview cannot sign");
  };
  // Address-only custom account; this SDK's type restriction does not imply a key exists.
  const previewOwner = toAccount({
    address: owner,
    sign: refuse,
    signAuthorization: refuse,
    signMessage: refuse,
    signTypedData: refuse,
    signTransaction: refuse,
  }) as PrivateKeyAccount;
  const account = await toSimple7702SmartAccount({
    client,
    owner: previewOwner,
  });
  const code = (await client.getCode({ address: owner })) ?? "0x",
    expected = `0xef0100${account.authorization.address.slice(2)}`;
  if (code !== "0x" && !same(code, expected))
    throw new Error("Unknown Robinhood delegation");
  const transport = http(
    `https://api.pimlico.io/v2/4663/rpc?apikey=${encodeURIComponent(key)}`,
    { retryCount: 0, timeout: 12000 },
  );
  const pimlico = createPimlicoClient({
    chain: robinhoodChain,
    transport,
    entryPoint: { address: entryPoint08Address, version: "0.8" },
  });
  const [supported, quotes] = await Promise.all([
    pimlico.getSupportedEntryPoints(),
    pimlico.getTokenQuotes({
      tokens: [ROBINHOOD_PROFILE.token],
      chain: robinhoodChain,
    }),
  ]);
  if (
    !supported.some((a) => same(a, entryPoint08Address)) ||
    quotes.length !== 1 ||
    !same(quotes[0]!.token, ROBINHOOD_PROFILE.token) ||
    !same(quotes[0]!.paymaster, ROBINHOOD_PROFILE.paymaster)
  )
    throw new Error("Unsupported USDG sponsorship");
  const market = async () => {
    const f = (await pimlico.getUserOperationGasPrice()).standard;
    uint(f.maxFeePerGas, true);
    uint(f.maxPriorityFeePerGas);
    if (f.maxPriorityFeePerGas > f.maxFeePerGas)
      throw new Error("Invalid USDG fees");
    return f;
  };
  async function prepare(
    calls: ExactCall[],
    fees: RobinhoodFeePrice,
    stateOverride?: StateOverride,
  ): Promise<RobinhoodPrepared> {
    const bundler = createSmartAccountClient({
      account,
      client,
      chain: robinhoodChain,
      bundlerTransport: transport,
      paymaster: {
        getPaymasterStubData: pimlico.getPaymasterStubData,
        getPaymasterData: pimlico.getPaymasterStubData,
      },
      userOperation: {
        estimateFeesPerGas: async () => fees,
        prepareUserOperation: prepareUserOperationForErc20Paymaster(pimlico),
      },
    });
    const initial = await bundler.prepareUserOperation({
      account,
      calls,
      nonce: await account.getNonce({ key: 0n }),
      paymasterContext: { token: ROBINHOOD_PROFILE.token },
      ...(stateOverride ? { stateOverride } : {}),
    });
    const allowance = await client.readContract({
      address: ROBINHOOD_PROFILE.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, ROBINHOOD_PROFILE.paymaster],
    });
    const op = await stabilizeRobinhoodApproval(
      initial,
      calls,
      allowance,
      async (allowed) => account.encodeCalls(allowed),
      async (operation) => {
        return estimateWithFreshPaymaster(operation,
          current => pimlico.estimateUserOperationGas({ ...current, account, ...(stateOverride ? { stateOverride } : {}) }),
          current => pimlico.getPaymasterStubData({ ...current, chainId: 4663, entryPointAddress: entryPoint08Address, context: { token: ROBINHOOD_PROFILE.token } }),
        );
      },
    );
    if (
      !same(op.sender, owner) ||
      !op.paymaster ||
      !same(op.paymaster, ROBINHOOD_PROFILE.paymaster) ||
      op.maxFeePerGas !== fees.maxFeePerGas ||
      op.maxPriorityFeePerGas !== fees.maxPriorityFeePerGas ||
      !account.decodeCalls
    )
      throw new Error("USDG operation identity/fee changed");
    const decoded = await account.decodeCalls(op.callData),
      plain = (c: { to: Address; data?: Hex; value?: bigint }) => ({
        to: c.to.toLowerCase(),
        data: (c.data ?? "0x").toLowerCase(),
        value: c.value ?? 0n,
      });
    if (
      (decoded.length !== calls.length &&
        decoded.length !== calls.length + 1) ||
      JSON.stringify(decoded.slice(-calls.length).map(plain), (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      ) !==
        JSON.stringify(calls.map(plain), (_, v) =>
          typeof v === "bigint" ? String(v) : v,
        )
    )
      throw new Error("USDG vault calls changed");
    const cap = robinhoodTokenCap(op);
    if (decoded.length === calls.length + 1) {
      const a = decoded[0]!;
      if (
        !same(a.to, ROBINHOOD_PROFILE.token) ||
        (a.value ?? 0n) !== 0n ||
        !a.data
      )
        throw new Error("Unknown USDG approval");
      const d = decodeFunctionData({ abi: erc20Abi, data: a.data });
      if (
        d.functionName !== "approve" ||
        !same(d.args[0], ROBINHOOD_PROFILE.paymaster) ||
        d.args[1] < cap ||
        d.args[1] > mulDiv(cap, 101n, 100n, "ceil")
      )
        throw new Error("USDG approval exceeds cap");
    } else if (allowance < cap) throw new Error("USDG allowance insufficient");
    const noFactory = op.factory === undefined && op.factoryData === undefined,
      stubFactory = op.factory === "0x7702" && op.factoryData === "0x";
    if (!noFactory && !stubFactory) throw new Error("Unexpected USDG factory");
    const currentEntryPointNonce = await account.getNonce({ key: 0n });
    const latest = await client.getTransactionCount({ address: owner }),
      pending = await client.getTransactionCount({
        address: owner,
        blockTag: "pending",
      });
    if (latest !== pending || currentEntryPointNonce !== op.nonce) throw new Error("Pending Robinhood nonce");
    if (
      op.authorization &&
      (op.authorization.chainId !== 4663 ||
        op.authorization.nonce !== latest ||
        !same(op.authorization.address, account.authorization.address))
    )
      throw new Error("Changed Robinhood authorization binding");
    const { validUntil } = assertPaymasterValidity(op.paymasterData, ROBINHOOD_PROFILE.token, BigInt(Math.floor(Date.now() / 1000)), 15n, 5n);
    return {
      operation: formatUserOperationRequest(op),
      feeCap: cap,
      fees,
      delegation: account.authorization.address,
      authorizationRequired: code === "0x",
      authorizationNonce: latest,
      ...(validUntil !== 0n ? { expiresAtMs: Number(validUntil) * 1000 } : {}),
    };
  }
  return { market, prepare };
}
