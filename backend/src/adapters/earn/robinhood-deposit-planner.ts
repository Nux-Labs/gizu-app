import {
  createPublicClient,
  erc20Abi,
  getAddress,
  keccak256,
  stringToHex,
} from "viem";
import type { Address, PublicClient } from "viem";
import { entryPoint08Address } from "viem/account-abstraction";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { mulDiv } from "../evm/gas-policy.ts";
import { evmReadTransport } from "../evm/read-transport.ts";
import type { ReferenceBlock } from "./policy.ts";
import { balance } from "./vault.ts";
import {
  ROBINHOOD_PROFILE,
  robinhoodChain,
  robinhoodVaultAbi,
} from "./robinhood-vault.ts";
import { simulateRobinhoodDeposit } from "./robinhood-simulation.ts";
import type { RobinhoodSimulation } from "./robinhood-simulation.ts";
import { createRobinhoodPaymaster } from "./robinhood-paymaster.ts";
import {
  RobinhoodPlanFailure,
  robinhoodPlanStage,
} from "./robinhood-plan-error.ts";
import type {
  RobinhoodFeePrice,
  RobinhoodPrepared,
} from "./robinhood-paymaster.ts";
export const ROBINHOOD_POLICY_VERSION =
  "robinhood-usdg-v1-price10-budget5-withdraw260" as const;
export type RobinhoodState = {
  owner: string;
  block: ReferenceBlock;
  token: bigint;
  shares: bigint;
  native: bigint;
  wrappedNative: bigint;
  nonce: bigint;
  ownerCode: string;
  shareDecimals: number;
};
export type RobinhoodPlannerConfig = {
  rpcUrl: string;
  pimlicoApiKey?: string;
  anvilPath?: string;
  timeoutMs?: number;
};
export type RobinhoodPlanRequest = {
  owner: string;
  operationId: string;
  revision: number;
};
export type RobinhoodPlannerProviders = {
  readState: (owner: Address) => Promise<RobinhoodState>;
  market: () => Promise<RobinhoodFeePrice>;
  simulate: (
    state: RobinhoodState,
    amount: bigint,
  ) => Promise<RobinhoodSimulation>;
  prepare: (
    calls: RobinhoodSimulation["depositCalls"],
    fees: RobinhoodFeePrice,
    override?: RobinhoodSimulation["stateOverride"],
  ) => Promise<RobinhoodPrepared>;
  assertFresh: (
    state: RobinhoodState,
    fees: RobinhoodFeePrice,
  ) => Promise<void>;
};
export type RobinhoodDepositPlan = {
  operationId: string;
  revision: number;
  policyVersion: typeof ROBINHOOD_POLICY_VERSION;
  profileId: "robinhood-usdg";
  chainId: 4663;
  owner: string;
  vault: string;
  router: string;
  token: string;
  tokenDecimals: 6;
  shareDecimals: number;
  wrappedNative: string;
  entryPoint: string;
  paymaster: string;
  referenceBlockNumber: string;
  referenceBlockHash: string;
  referenceTimestampMs: number;
  quotedAtMs: number;
  expiresAtMs: number;
  planHash: string;
  nonce: string;
  accountCode: string;
  startingBalances: {
    usdg: string;
    nativeEth: string;
    wrappedNative: string;
    shares: string;
  };
  depositAmount: string;
  depositFeeBudget: string;
  depositQuoteCap: string;
  withdrawalReserve: string;
  withdrawalQuoteCap: string;
  retainedLiquidUsdg: string;
  previewShares: string;
  maxSharePrice: string;
  deadline: string;
  fees: {
    maximumFeeWei: string;
    priorityFeeWei: string;
    priceHeadroomBps: 1000;
    operationBudgetHeadroomBps: 500;
    withdrawalReserveMultiplierBps: 26000;
  };
  authorization: {
    required: boolean;
    delegation: string;
    nonce: string;
    chainId: 4663;
  };
  operation: Record<string, unknown>;
  paymasterDataStatus: "stub";
  simulation: {
    deposit: { estimatedGas: string; actualGas: string }[];
    withdrawal: { estimatedGas: string; actualGas: string }[];
    postDepositShares: string;
    withdrawalPurpose: "reserve-only-isolated-fork";
    fundingAssumption: "real-USDG-balance-with-fork-only-native-gas-override";
    overrideScope: "verified-post-deposit-storage-only";
  };
  exclusions: string[];
  readOnly: true;
  simulationAvailable: true;
  executionAvailable: false;
};
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.freeze(v);
    for (const value of Object.values(v)) freeze(value);
  }
  return v;
}
export async function readRobinhoodState(
  client: PublicClient,
  owner: Address,
  now: () => number = Date.now,
): Promise<RobinhoodState> {
  if ((await client.getChainId()) !== 4663)
    throw new Error("Wrong Robinhood chain");
  const block = await client.getBlock(),
    timestampMs = Number(block.timestamp) * 1000;
  if (
    !/^0x[0-9a-f]{64}$/i.test(block.hash) ||
    /^0x0{64}$/i.test(block.hash) ||
    !Number.isSafeInteger(timestampMs) ||
    now() - timestampMs > 60000 ||
    timestampMs - now() > 5000
  )
    throw new Error("Stale Robinhood reference");
  const args = { blockNumber: block.number };
  const [
    codes,
    asset,
    decimals,
    shareDecimals,
    token,
    shares,
    native,
    wrappedNative,
    nonce,
    pending,
    ownerCode,
  ] = await Promise.all([
    Promise.all(
      [
        ROBINHOOD_PROFILE.token,
        ROBINHOOD_PROFILE.vault,
        ROBINHOOD_PROFILE.router,
        ROBINHOOD_PROFILE.wrappedNative,
        ROBINHOOD_PROFILE.paymaster,
        entryPoint08Address,
      ].map((address) => client.getCode({ address, ...args })),
    ),
    client.readContract({
      address: ROBINHOOD_PROFILE.vault,
      abi: robinhoodVaultAbi,
      functionName: "asset",
      ...args,
    }),
    client.readContract({
      address: ROBINHOOD_PROFILE.token,
      abi: erc20Abi,
      functionName: "decimals",
      ...args,
    }),
    client.readContract({
      address: ROBINHOOD_PROFILE.vault,
      abi: erc20Abi,
      functionName: "decimals",
      ...args,
    }),
    balance(client, ROBINHOOD_PROFILE.token, owner, block.number),
    balance(client, ROBINHOOD_PROFILE.vault, owner, block.number),
    client.getBalance({ address: owner, ...args }),
    balance(client, ROBINHOOD_PROFILE.wrappedNative, owner, block.number),
    client.getTransactionCount({ address: owner, ...args }),
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
    client.getCode({ address: owner, ...args }),
  ]);
  if (
    codes.some((code) => !code || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) ||
    asset.toLowerCase() !== ROBINHOOD_PROFILE.token.toLowerCase() ||
    decimals !== 6 ||
    nonce !== pending
  )
    throw new Error("Unsupported Robinhood token/vault/nonce");
  if (
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new Error("Robinhood reference reorg");
  return {
    owner,
    block: {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
      baseFeePerGas: block.baseFeePerGas ?? 0n,
      gasUsed: block.gasUsed,
      gasLimit: block.gasLimit,
    },
    token,
    shares,
    native,
    wrappedNative,
    nonce: BigInt(nonce),
    ownerCode: ownerCode ?? "0x",
    shareDecimals,
  };
}
export function createRobinhoodPlannerProviders(
  config: RobinhoodPlannerConfig,
  now: () => number = Date.now,
): RobinhoodPlannerProviders {
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: evmReadTransport(config.rpcUrl),
    cacheTime: 0,
  });
  let paymaster:
    Awaited<ReturnType<typeof createRobinhoodPaymaster>> | undefined;
  let destination: Address | undefined;
  const requirePaymaster = async () => {
    if (!destination) throw new Error("Robinhood destination unavailable");
    return (paymaster ??= await createRobinhoodPaymaster(
      client,
      destination,
      config.pimlicoApiKey ?? "",
    ));
  };
  return {
    readState: async (owner) => {
      destination = owner;
      return readRobinhoodState(client, owner, now);
    },
    market: async () => (await requirePaymaster()).market(),
    prepare: async (calls, fees, override) =>
      (await requirePaymaster()).prepare(calls, fees, override),
    simulate: (state, amount) => {
      if (!config.anvilPath) throw new Error("Robinhood fork unavailable");
      return simulateRobinhoodDeposit({
        rpcUrl: config.rpcUrl,
        anvilPath: config.anvilPath,
        timeoutMs: config.timeoutMs,
        block: state.block,
        owner: getAddress(state.owner),
        amount,
      });
    },
    assertFresh: async (state, fees) => {
      const fresh = await readRobinhoodState(
          client,
          getAddress(state.owner),
          now,
        ),
        market = await (await requirePaymaster()).market();
      if (
        (await client.getBlock({ blockNumber: state.block.number })).hash !==
          state.block.hash ||
        now() - Number(state.block.timestamp) * 1000 > 60000 ||
        market.maxFeePerGas > fees.maxFeePerGas ||
        market.maxPriorityFeePerGas > fees.maxPriorityFeePerGas ||
        [
          "token",
          "shares",
          "native",
          "wrappedNative",
          "nonce",
          "ownerCode",
        ].some(
          (key) =>
            state[key as keyof RobinhoodState] !==
            fresh[key as keyof RobinhoodState],
        )
      )
        throw new Error("Robinhood state/fees changed");
    },
  };
}

export class RobinhoodDepositPlanner {
  private providers?: RobinhoodPlannerProviders;
  constructor(
    private config: RobinhoodPlannerConfig,
    providers?: RobinhoodPlannerProviders,
    private now: () => number = Date.now,
  ) {
    this.providers = providers;
  }
  async plan(request: RobinhoodPlanRequest): Promise<RobinhoodDepositPlan> {
    if (
      !/^0x[0-9a-f]{40}$/i.test(request.owner) ||
      /^0x0{40}$/i.test(request.owner) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 1 ||
      !/^[-a-zA-Z0-9_]{1,128}$/.test(request.operationId)
    )
      throw new InfrastructureError(
        400,
        "INVALID_EARN_PLAN_REQUEST",
        "A destination owner, operation ID and positive revision are required.",
      );
    try {
      const providers =
        this.providers ??
        createRobinhoodPlannerProviders(this.config, this.now);
      const owner = getAddress(request.owner),
        state = await robinhoodPlanStage("read-state", () =>
          providers.readState(owner),
        );
      if (
        state.owner.toLowerCase() !== owner.toLowerCase() ||
        this.now() - Number(state.block.timestamp) * 1000 > 60000 ||
        Number(state.block.timestamp) * 1000 - this.now() > 5000
      )
        throw new Error("Stale Robinhood owner binding");
      if (state.token <= 1n)
        throw new InfrastructureError(
          409,
          "EARN_PREFUNDING_REQUIRED",
          "A confirmed Robinhood USDG payout is required before a real deposit plan.",
        );
      if (state.shares !== 0n)
        throw new InfrastructureError(
          409,
          "EARN_EXISTING_SHARES_UNSUPPORTED",
          "Resolve existing Robinhood vault shares before a new deposit.",
        );
      if (state.native !== 0n || state.wrappedNative !== 0n)
        throw new InfrastructureError(
          409,
          "EARN_RESIDUAL_ASSET_RECONCILIATION_REQUIRED",
          "Reconcile Robinhood native and wrapped ETH before a USDG-only deposit.",
        );
      const market = await robinhoodPlanStage("fee-market", () =>
          providers.market(),
        ),
        fees = {
          maxFeePerGas: mulDiv(market.maxFeePerGas, 110n, 100n, "ceil"),
          maxPriorityFeePerGas: mulDiv(market.maxPriorityFeePerGas, 110n, 100n, "ceil"),
        };
      let amount = state.token / 2n,
        depositQuoteCap = 0n,
        withdrawalQuoteCap = 0n;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (
          amount <= 0n ||
          this.now() >= Number(state.block.timestamp) * 1000 + 60000
        )
          throw new Error("Insufficient or stale USDG budget");
        const simulation = await robinhoodPlanStage("vault-simulation", () =>
          providers.simulate(state, amount),
        );
        // Both preparations are read-only and use the same pinned simulation and fee ceiling.
        const [deposit, withdrawal] = await Promise.all([
          robinhoodPlanStage("deposit-sponsorship", () =>
            providers.prepare(
              simulation.depositCalls,
              fees,
              simulation.fundingOverride,
            ),
          ),
          robinhoodPlanStage("withdrawal-sponsorship", () =>
            providers.prepare(
              simulation.withdrawalCalls,
              fees,
              simulation.stateOverride,
            ),
          ),
        ]);
        // Keep a conservative feasible budget instead of chasing smaller moving quotes.
        depositQuoteCap =
          deposit.feeCap > depositQuoteCap ? deposit.feeCap : depositQuoteCap;
        withdrawalQuoteCap =
          withdrawal.feeCap > withdrawalQuoteCap
            ? withdrawal.feeCap
            : withdrawalQuoteCap;
        const depositFeeBudget = mulDiv(depositQuoteCap, 105n, 100n, "ceil"),
          withdrawalReserve = mulDiv(withdrawalQuoteCap, 260n, 100n, "ceil"),
          next = state.token - depositFeeBudget - withdrawalReserve;
        if (next <= 0n) throw new Error("Insufficient USDG gas reserve");
        if (next !== amount) {
          amount = next;
          continue;
        }
        const final = await robinhoodPlanStage("final-sponsorship", () =>
          providers.prepare(
            simulation.depositCalls,
            fees,
            simulation.fundingOverride,
          ),
        );
        if (final.feeCap > depositFeeBudget)
          throw new Error("Final USDG cap exceeds deposit budget");
        await robinhoodPlanStage("freshness", () =>
          providers.assertFresh(state, fees),
        );
        if (this.now() >= Number(state.block.timestamp) * 1000 + 60000)
          throw new Error("Robinhood plan expired");
        const {
          signature: _signature,
          eip7702Auth: _auth,
          authorization: _authorization,
          ...operation
        } = final.operation as Record<string, unknown>;
        const quotedAtMs = this.now();
        const plan: RobinhoodDepositPlan = {
          operationId: request.operationId,
          revision: request.revision,
          policyVersion: ROBINHOOD_POLICY_VERSION,
          profileId: "robinhood-usdg",
          chainId: 4663,
          owner,
          vault: ROBINHOOD_PROFILE.vault,
          router: ROBINHOOD_PROFILE.router,
          token: ROBINHOOD_PROFILE.token,
          tokenDecimals: 6,
          shareDecimals: state.shareDecimals,
          wrappedNative: ROBINHOOD_PROFILE.wrappedNative,
          entryPoint: entryPoint08Address,
          paymaster: ROBINHOOD_PROFILE.paymaster,
          referenceBlockNumber: String(state.block.number),
          referenceBlockHash: state.block.hash,
          referenceTimestampMs: Number(state.block.timestamp) * 1000,
          quotedAtMs,
          expiresAtMs: Math.min(
            quotedAtMs + 45000,
            Number(state.block.timestamp) * 1000 + 60000,
            final.expiresAtMs ?? Infinity,
          ),
          planHash: "",
          nonce: String(state.nonce),
          accountCode: state.ownerCode,
          startingBalances: {
            usdg: String(state.token),
            nativeEth: String(state.native),
            wrappedNative: String(state.wrappedNative),
            shares: String(state.shares),
          },
          depositAmount: String(amount),
          depositFeeBudget: String(depositFeeBudget),
          depositQuoteCap: String(depositQuoteCap),
          withdrawalReserve: String(withdrawalReserve),
          withdrawalQuoteCap: String(withdrawalQuoteCap),
          retainedLiquidUsdg: String(state.token - amount),
          previewShares: String(simulation.previewShares),
          maxSharePrice: String(simulation.maxSharePrice),
          deadline: String(state.block.timestamp + 600n),
          fees: {
            maximumFeeWei: String(fees.maxFeePerGas),
            priorityFeeWei: String(fees.maxPriorityFeePerGas),
            priceHeadroomBps: 1000,
            operationBudgetHeadroomBps: 500,
            withdrawalReserveMultiplierBps: 26000,
          },
          authorization: {
            required: final.authorizationRequired,
            delegation: final.delegation,
            nonce: String(final.authorizationNonce),
            chainId: 4663,
          },
          operation,
          paymasterDataStatus: "stub",
          simulation: {
            deposit: simulation.deposit.map((r) => ({
              estimatedGas: String(r.estimatedGas),
              actualGas: String(r.actualGas),
            })),
            withdrawal: simulation.withdrawal.map((r) => ({
              estimatedGas: String(r.estimatedGas),
              actualGas: String(r.actualGas),
            })),
            postDepositShares: String(simulation.shares),
            withdrawalPurpose: "reserve-only-isolated-fork",
            fundingAssumption:
              "real-USDG-balance-with-fork-only-native-gas-override",
            overrideScope: "verified-post-deposit-storage-only",
          },
          exclusions: [
            "Final execution requires fresh non-stub USDG sponsorship and separate native approval.",
            "Withdrawal is a separate user action; future fees and liquidity are not guaranteed.",
            "Aurora return costs are excluded and must be re-quoted after withdrawal.",
          ],
          readOnly: true,
          simulationAvailable: true,
          executionAvailable: false,
        };
        plan.planHash = keccak256(stringToHex(JSON.stringify(plan)));
        return freeze(plan);
      }
      throw new Error("USDG deposit funding did not converge");
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      throw new RobinhoodPlanFailure("plan-validation", error);
    }
  }
}
