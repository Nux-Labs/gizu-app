import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
} from "viem";
import type { Address, Hex } from "viem";
import { randomBytes } from "node:crypto";
import { entryPoint08Address } from "viem/account-abstraction";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { auroraApi } from "../aurora/http.ts";
import { monadUsdcAssetId, robinhoodUsdgAssetId } from "../aurora/assets.ts";
import { ceilDiv } from "./policy.ts";
import { balance } from "./vault.ts";
import type { ExactCall } from "./vault.ts";
import { withPinnedFork, simulateForkSequence } from "./fork-simulation.ts";
import type { SimulationRow } from "./fork-simulation.ts";
import { readRobinhoodState } from "./robinhood-deposit-planner.ts";
import type {
  RobinhoodState,
  RobinhoodPlannerConfig,
  RobinhoodPlanRequest,
} from "./robinhood-deposit-planner.ts";
import {
  ROBINHOOD_PROFILE,
  robinhoodChain,
  robinhoodCalls,
} from "./robinhood-vault.ts";
import { createRobinhoodPaymaster } from "./robinhood-paymaster.ts";
import type {
  RobinhoodPrepared,
  RobinhoodFeePrice,
} from "./robinhood-paymaster.ts";
import type {
  NativeEarnGateway,
  NativeQuoteInput,
  NativeVerifiedQuote,
} from "./native-gateway.ts";
export interface RobinhoodExitConfig extends RobinhoodPlannerConfig {
  auroraApiKey?: string;
}
export interface RobinhoodExitSimulation {
  rows: SimulationRow[];
  remainingShares: bigint;
  remainingToken: bigint;
  receivedToken: bigint;
}
export interface RobinhoodExitProviders {
  readState: (owner: Address) => Promise<RobinhoodState>;
  market: () => Promise<RobinhoodFeePrice>;
  prepare: (
    calls: ExactCall[],
    fees: RobinhoodFeePrice,
  ) => Promise<RobinhoodPrepared>;
  withdrawalCalls: (state: RobinhoodState) => Promise<ExactCall[]>;
  simulate: (
    state: RobinhoodState,
    calls: ExactCall[],
    kind: "withdrawal" | "return",
    amount: bigint,
  ) => Promise<RobinhoodExitSimulation>;
  assertFresh: (
    state: RobinhoodState,
    fees: RobinhoodFeePrice,
  ) => Promise<void>;
  price: () => Promise<{ tokenPriceMicroUsdc: bigint; observedAtMs: number }>;
  quote: (input: NativeQuoteInput) => Promise<NativeVerifiedQuote>;
  returnProbeRecipient: (state: RobinhoodState) => Promise<Address>;
}

/** An existing token holder is a cheaper transfer target than a fresh route deposit address. */
export async function robinhoodReturnProbeRecipient(
  client: Pick<ReturnType<typeof createPublicClient>, "readContract">,
  state: RobinhoodState,
  random: () => Uint8Array = () => randomBytes(20),
): Promise<Address> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = random();
    if (bytes.length !== 20 || bytes.some((v) => v === 0)) continue;
    const candidate = getAddress("0x" + Buffer.from(bytes).toString("hex"));
    if (same(candidate, state.owner)) continue;
    const held = await client.readContract({
      address: ROBINHOOD_PROFILE.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [candidate],
      blockNumber: state.block.number,
    });
    if (held === 0n) return candidate;
  }
  throw new Error("No conservative USDG return probe recipient");
}
const accountAbi = parseAbi([
  "function execute(address target,uint256 value,bytes data)",
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Decode the exact SDK encoding, including its bounded token-fee approval. */
export function robinhoodPreparedCalls(
  prepared: RobinhoodPrepared,
): ExactCall[] {
  const data = prepared.operation.callData;
  if (typeof data !== "string") throw new Error("Missing account encoding");
  const decoded = decodeFunctionData({ abi: accountAbi, data: data as Hex });
  const calls =
    decoded.functionName === "execute"
      ? [{ to: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
      : decoded.args[0].map((c) => ({
          to: c.target,
          value: c.value,
          data: c.data,
        }));
  if (calls.length < 1 || calls.length > 4 || calls.some((c) => c.value !== 0n))
    throw new Error("Unbounded USDG exit calls");
  return calls;
}
/** Disposable fork only; no native ETH or token funds are changed on the origin. */
export async function simulateRobinhoodExit(
  config: RobinhoodExitConfig,
  state: RobinhoodState,
  calls: ExactCall[],
  kind: "withdrawal" | "return",
  amount: bigint,
): Promise<RobinhoodExitSimulation> {
  if (!config.anvilPath) throw new Error("Exit fork unavailable");
  return withPinnedFork(
    {
      rpcUrl: config.rpcUrl,
      anvilPath: config.anvilPath,
      timeoutMs: config.timeoutMs,
      block: state.block,
      chain: robinhoodChain,
    },
    async (client, signal) => {
      const owner = getAddress(state.owner),
        rpc = (method: string, params: unknown[]) =>
          client.request({ method, params } as never);
      if (
        (await balance(client, ROBINHOOD_PROFILE.token, owner)) !==
          state.token ||
        (await balance(client, ROBINHOOD_PROFILE.vault, owner)) !== state.shares
      )
        throw new Error("Fork position changed");
      await rpc("anvil_setBlockTimestampInterval", [0]);
      await rpc("anvil_impersonateAccount", [owner]);
      await rpc("anvil_setBalance", [owner, toHex(10n ** 24n)]);
      const rows = await simulateForkSequence(client, owner, calls, signal);
      const remainingShares = await balance(
          client,
          ROBINHOOD_PROFILE.vault,
          owner,
        ),
        remainingToken = await balance(client, ROBINHOOD_PROFILE.token, owner);
      if (
        remainingShares !== 0n ||
        (kind === "return" && remainingToken !== state.token - amount) ||
        (kind === "withdrawal" && remainingToken <= state.token)
      )
        throw new Error("Exit simulation did not reconcile");
      return {
        rows,
        remainingShares,
        remainingToken,
        receivedToken:
          kind === "withdrawal" ? remainingToken - state.token : amount,
      };
    },
  );
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid price registry");
  return v as Record<string, unknown>;
}
function positiveDecimal(v: unknown): { n: bigint; d: bigint } {
  if (
    (typeof v !== "number" && typeof v !== "string") ||
    (typeof v === "number" && (!Number.isFinite(v) || v <= 0))
  )
    throw new Error("Invalid price");
  const match = String(v).match(
    /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?(?:[eE]([+-]?[0-9]{1,2}))?$/,
  );
  if (!match) throw new Error("Unsupported price precision");
  const fraction = match[2] ?? "",
    exponent = Number(match[3] ?? 0) - fraction.length;
  if (Math.abs(exponent) > 36) throw new Error("Price exponent out of bounds");
  const n = BigInt(match[1]! + fraction);
  if (n <= 0n) throw new Error("Zero price");
  return exponent >= 0
    ? { n: n * 10n ** BigInt(exponent), d: 1n }
    : { n, d: 10n ** BigInt(-exponent) };
}
/** Fresh USDG / fresh USDC valuation, rounded upward in exact integer units. */
export function robinhoodExitPrice(body: unknown, now: number) {
  const tokens = record(body).tokens;
  if (!Array.isArray(tokens) || tokens.length > 10000)
    throw new Error("Unbounded price registry");
  const select = (assetId: string, contract: string, chain: string) => {
    const rows = tokens.map(record).filter((t) => t.assetId === assetId);
    if (rows.length !== 1) throw new Error("Ambiguous valuation");
    const t = rows[0]!,
      date =
        typeof t.priceUpdatedAt === "string"
          ? Date.parse(t.priceUpdatedAt)
          : NaN;
    if (
      t.blockchain !== chain ||
      t.decimals !== 6 ||
      typeof t.contractAddress !== "string" ||
      !same(t.contractAddress, contract) ||
      !Number.isSafeInteger(date) ||
      now - date > 300000 ||
      date > now + 60000
    )
      throw new Error("Stale or changed token valuation");
    return { price: positiveDecimal(t.price), date };
  };
  const token = select(robinhoodUsdgAssetId, ROBINHOOD_PROFILE.token, "hood"),
    usdc = select(
      monadUsdcAssetId,
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      "monad",
    );
  const tokenPriceMicroUsdc = ceilDiv(
    token.price.n * usdc.price.d * 1000000n,
    token.price.d * usdc.price.n,
  );
  if (tokenPriceMicroUsdc <= 0n || tokenPriceMicroUsdc >= 1n << 256n)
    throw new Error("Invalid relative USDG price");
  return { tokenPriceMicroUsdc, observedAtMs: Math.min(token.date, usdc.date) };
}
function runtime(
  config: RobinhoodExitConfig,
  gateway: Pick<NativeEarnGateway, "returnQuote"> | undefined,
  now: () => number,
): RobinhoodExitProviders {
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(config.rpcUrl, { timeout: 12000, retryCount: 0 }),
    cacheTime: 0,
  });
  let owner: Address | undefined,
    paymaster: Awaited<ReturnType<typeof createRobinhoodPaymaster>> | undefined;
  const requirePaymaster = async () => {
    if (!owner) throw new Error("Unknown exit owner");
    return (paymaster ??= await createRobinhoodPaymaster(
      client,
      owner,
      config.pimlicoApiKey ?? "",
    ));
  };
  return {
    readState: async (address) => {
      owner = address;
      return readRobinhoodState(client, address, now);
    },
    returnProbeRecipient: (state) => robinhoodReturnProbeRecipient(client, state),
    market: async () => (await requirePaymaster()).market(),
    prepare: async (calls, fees) =>
      (await requirePaymaster()).prepare(calls, fees),
    withdrawalCalls: async (s) =>
      (
        await robinhoodCalls(
          client,
          getAddress(s.owner),
          "withdraw",
          s.shares,
          s.block.timestamp + 600n,
        )
      ).calls,
    simulate: (s, calls, kind, amount) =>
      simulateRobinhoodExit(config, s, calls, kind, amount),
    price: async () => {
      if (!config.auroraApiKey) throw new Error("USDG valuation unconfigured");
      return robinhoodExitPrice(
        await auroraApi(
          config.auroraApiKey,
          fetch,
          `tokens/{key}?valuationAt=${now()}`,
        ),
        now(),
      );
    },
    quote: async (input) => {
      if (!gateway) throw new Error("Return quote registry unconfigured");
      return gateway.returnQuote(input);
    },
    assertFresh: async (s, fees) => {
      const [fresh, canonical, market] = await Promise.all([
        readRobinhoodState(client, getAddress(s.owner), now),
        client.getBlock({ blockNumber: s.block.number }),
        (await requirePaymaster()).market(),
      ]);
      if (
        canonical.hash !== s.block.hash ||
        now() - Number(s.block.timestamp) * 1000 > 60000 ||
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
          (k) =>
            s[k as keyof RobinhoodState] !== fresh[k as keyof RobinhoodState],
        )
      )
        throw new Error("USDG exit reference changed");
    },
  };
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function validate(request: RobinhoodPlanRequest) {
  if (
    !/^0x[0-9a-f]{40}$/i.test(request.owner) ||
    /^0x0{40}$/i.test(request.owner) ||
    !/^[-a-zA-Z0-9_]{1,128}$/.test(request.operationId) ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 1
  )
    throw new InfrastructureError(
      400,
      "INVALID_EARN_EXIT_REQUEST",
      "An owner, operation and positive revision are required.",
    );
}
function stateValid(s: RobinhoodState, owner: Address, now: number) {
  if (
    !same(s.owner, owner) ||
    s.native !== 0n ||
    s.wrappedNative !== 0n ||
    now - Number(s.block.timestamp) * 1000 > 60000 ||
    Number(s.block.timestamp) * 1000 > now + 5000 ||
    (s.ownerCode !== "0x" &&
      !same(s.ownerCode, "0xef0100e6Cae83BdE06E4c305530e199D7217f42808555B"))
  )
    throw new Error("USDG exit assets or owner require reconciliation");
}
function buffered(m: RobinhoodFeePrice) {
  if (
    m.maxFeePerGas <= 0n ||
    m.maxPriorityFeePerGas < 0n ||
    m.maxPriorityFeePerGas > m.maxFeePerGas
  )
    throw new Error("Invalid USDG market");
  return {
    maxFeePerGas: ceilDiv(m.maxFeePerGas * 110n, 100n),
    maxPriorityFeePerGas: ceilDiv(m.maxPriorityFeePerGas * 110n, 100n),
  };
}
function preparedValid(
  p: RobinhoodPrepared,
  s: RobinhoodState,
  fees: RobinhoodFeePrice,
  now: number,
) {
  if (
    p.feeCap <= 0n ||
    p.feeCap >= 1n << 256n ||
    p.authorizationNonce !== Number(s.nonce) ||
    p.fees.maxFeePerGas !== fees.maxFeePerGas ||
    p.fees.maxPriorityFeePerGas !== fees.maxPriorityFeePerGas ||
    (p.expiresAtMs ?? Infinity) <= now + 5000
  )
    throw new Error("Invalid USDG exit fee reference");
}
function base(
  request: RobinhoodPlanRequest,
  s: RobinhoodState,
  p: RobinhoodPrepared,
  fees: RobinhoodFeePrice,
  budget: bigint,
  now: number,
) {
  const {
    signature: _sig,
    eip7702Auth: _auth,
    authorization: _authorization,
    ...operation
  } = p.operation as Record<string, unknown>;
  return {
    operationId: request.operationId,
    revision: request.revision,
    profileId: "robinhood-usdg" as const,
    chainId: 4663 as const,
    owner: getAddress(s.owner),
    token: ROBINHOOD_PROFILE.token,
    tokenDecimals: 6 as const,
    vault: ROBINHOOD_PROFILE.vault,
    router: ROBINHOOD_PROFILE.router,
    entryPoint: entryPoint08Address,
    paymaster: ROBINHOOD_PROFILE.paymaster,
    wrappedNative: ROBINHOOD_PROFILE.wrappedNative,
    shareDecimals: s.shareDecimals,
    referenceBlockNumber: s.block.number.toString(),
    referenceBlockHash: s.block.hash,
    referenceTimestampMs: Number(s.block.timestamp) * 1000,
    quotedAtMs: now,
    expiresAtMs: Math.min(
      now + 45000,
      Number(s.block.timestamp) * 1000 + 60000,
      p.expiresAtMs ?? Infinity,
    ),
    nonce: s.nonce.toString(),
    startingBalances: {
      usdg: s.token.toString(),
      shares: s.shares.toString(),
      nativeEth: "0",
      wrappedNative: "0",
    },
    maximumTokenFeeAtoms: budget.toString(),
    finalQuoteCapAtoms: p.feeCap.toString(),
    retainedAfterActionAtoms: "0" as const,
    authorization: {
      required: p.authorizationRequired,
      delegation: p.delegation,
      nonce: String(p.authorizationNonce),
      chainId: 4663 as const,
    },
    fees: {
      maxFeePerGasWei: fees.maxFeePerGas.toString(),
      priorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(),
      priceHeadroomBps: 1000 as const,
      operationBudgetHeadroomBps: 500 as const,
    },
    operation,
    paymasterDataStatus: "stub" as const,
    readOnly: true as const,
    executionAvailable: false as const,
    planHash: "",
  };
}
export type RobinhoodWithdrawalPlan = ReturnType<typeof base> & {
  kind: "hoodRedeemAll";
  amountAtoms: string;
  deadline: string;
  previewRedeemedUsdg: string;
  simulation: { estimatedGas: string; actualGas: string }[];
  returnsQuoted: false;
  minimumAssetsGuard: false;
  exclusions: string[];
};
export class RobinhoodWithdrawalPlanner {
  constructor(
    private config: RobinhoodExitConfig,
    private providers?: RobinhoodExitProviders,
    private now: () => number = Date.now,
  ) {}
  async plan(request: RobinhoodPlanRequest): Promise<RobinhoodWithdrawalPlan> {
    validate(request);
    try {
      const providers =
          this.providers ?? runtime(this.config, undefined, this.now),
        owner = getAddress(request.owner),
        s = await providers.readState(owner);
      stateValid(s, owner, this.now());
      if (s.shares <= 0n) throw new Error("No current shares");
      const fees = buffered(await providers.market()),
        calls = await providers.withdrawalCalls(s),
        initial = await providers.prepare(calls, fees);
      preparedValid(initial, s, fees, this.now());
      const budget = ceilDiv(initial.feeCap * 105n, 100n);
      if (s.token < budget)
        throw new InfrastructureError(
          409,
          "EARN_WITHDRAWAL_RESERVE_INSUFFICIENT",
          "Current USDG cannot fund the fresh withdrawal cap and headroom. No shares were redeemed.",
        );
      const final = await providers.prepare(calls, fees);
      preparedValid(final, s, fees, this.now());
      if (final.feeCap > budget)
        throw new Error("Exact withdrawal fee exceeds budget");
      const simulation = await providers.simulate(
        s,
        robinhoodPreparedCalls(final),
        "withdrawal",
        s.shares,
      );
      if (
        simulation.remainingShares !== 0n ||
        simulation.receivedToken <= 0n ||
        !simulation.rows.length ||
        simulation.rows.length > 4
      )
        throw new Error("Full withdrawal simulation failed");
      await providers.assertFresh(s, fees);
      const plan: RobinhoodWithdrawalPlan = {
        ...base(request, s, final, fees, budget, this.now()),
        kind: "hoodRedeemAll",
        amountAtoms: s.shares.toString(),
        deadline: (s.block.timestamp + 600n).toString(),
        previewRedeemedUsdg: simulation.receivedToken.toString(),
        simulation: simulation.rows.map((row) => ({
          estimatedGas: row.estimatedGas.toString(),
          actualGas: row.actualGas.toString(),
        })),
        returnsQuoted: false,
        minimumAssetsGuard: false,
        exclusions: [
          "No Aurora return cost is reserved by this fresh withdrawal; return quotes follow confirmed zero shares.",
          "Fork executes exact calls but does not charge the paymaster token fee; live execution requires fresh final sponsorship and separate native authorization.",
        ],
      };
      plan.planHash = keccak256(stringToHex(JSON.stringify(plan)));
      return freeze(plan);
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      throw new InfrastructureError(
        502,
        "EARN_ROBINHOOD_WITHDRAWAL_UNAVAILABLE",
        "Could not verify current shares, actual USDG gas reserve and full fork withdrawal. No transaction was sent.",
      );
    }
  }
}
export type RobinhoodReturnPlan = ReturnType<typeof base> & {
  kind: "hoodTokenReturn";
  amountAtoms: string;
  confidentialAccount: Address;
  recipient: Address;
  route: NativeVerifiedQuote;
  deadline: string;
  price: {
    tokenPriceMicroUsdc: string;
    observedAtMs: number;
    maximumAgeMs: 300000;
  };
  maximumResidualUsdcAtoms: string;
  optimalResidualUpperBound: boolean;
  residualTargetMet: true;
  simulation: { estimatedGas: string; actualGas: string }[];
  quotePolicy: "one-immutable-quote-after-fee-probe";
  completionRequires: string[];
};
export class RobinhoodReturnPlanner {
  constructor(
    private config: RobinhoodExitConfig,
    private gateway?: Pick<NativeEarnGateway, "returnQuote">,
    private providers?: RobinhoodExitProviders,
    private now: () => number = Date.now,
  ) {}
  async plan(
    request: RobinhoodPlanRequest & { confidentialAccount: string; settlementMode?: "balance-delta-v1" },
  ): Promise<RobinhoodReturnPlan> {
    validate(request);
    if (
      !/^0x[0-9a-f]{40}$/i.test(request.confidentialAccount) ||
      /^0x0{40}$/i.test(request.confidentialAccount) ||
      same(request.confidentialAccount, request.owner)
    )
      throw new InfrastructureError(
        400,
        "INVALID_EARN_RETURN_ACCOUNT",
        "A separate native confidential account is required.",
      );
    try {
      const providers =
          this.providers ?? runtime(this.config, this.gateway, this.now),
        owner = getAddress(request.owner),
        s = await providers.readState(owner);
      stateValid(s, owner, this.now());
      if (s.shares !== 0n || s.token <= 1n)
        throw new Error("Return requires confirmed zero shares and real USDG");
      const fees = buffered(await providers.market()),
        price = await providers.price();
      if (
        price.tokenPriceMicroUsdc <= 0n ||
        price.tokenPriceMicroUsdc >= 1n << 256n ||
        !Number.isSafeInteger(price.observedAtMs) ||
        this.now() - price.observedAtMs > 300000 ||
        price.observedAtMs > this.now() + 60000
      )
        throw new Error("USDG valuation unavailable");
      const transfer = (to: Address, amount: bigint): ExactCall => ({
        to: ROBINHOOD_PROFILE.token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
        }),
      });
      const probeRecipient = await providers.returnProbeRecipient(s);
      let amount = s.token / 2n,
        budget = 0n,
        stable = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (
          amount <= 0n ||
          this.now() >= Number(s.block.timestamp) * 1000 + 60000
        )
          throw new Error("Insufficient or stale return balance");
        const probe = await providers.prepare(
          [
            transfer(probeRecipient, amount),
          ],
          fees,
        );
        preparedValid(probe, s, fees, this.now());
        budget = ceilDiv(probe.feeCap * 105n, 100n);
        const next = s.token - budget;
        if (next <= 0n) throw new Error("USDG return reserve insufficient");
        if (next !== amount) {
          amount = next;
          continue;
        }
        stable = true;
        break;
      }
      if (!stable) throw new Error("Return fee did not converge");
      const residualValue = ceilDiv(
        (s.token - amount) * price.tokenPriceMicroUsdc,
        1000000n,
      );
      if (residualValue >= 500000n)
        throw new InfrastructureError(
          409,
          "EARN_RETURN_RESIDUAL_TOO_HIGH",
          "The conservative remaining USDG value is not below 0.50 USDC. Wait for a fresh fee quote.",
        );
      await providers.assertFresh(s, fees);
      const route = await providers.quote({
        operationId: request.operationId,
        revision: request.revision,
        profileChainId: 4663,
        sourceOwner: owner,
        confidentialAccount: getAddress(request.confidentialAccount),
        amountAtoms: amount.toString(),
        settlementMode: request.settlementMode,
      });
      if (
        route.operationId !== request.operationId ||
        route.revision !== request.revision ||
        route.chainId !== 4663 ||
        !same(route.token, ROBINHOOD_PROFILE.token) ||
        !same(route.refundOwner, owner) ||
        !same(route.confidentialAccount, request.confidentialAccount) ||
        route.amountAtoms !== amount.toString() ||
        route.originAsset !== robinhoodUsdgAssetId ||
        (!Number.isSafeInteger(route.providerFeeBps) || route.providerFeeBps < 0 || route.providerFeeBps > 100) ||
        !/^0x[0-9a-f]{64}$/i.test(route.quoteId) ||
        !/^0x[0-9a-f]{64}$/i.test(route.authenticatedBodyHash) ||
        !/^[1-9][0-9]{0,77}$/.test(route.minimumCreditAtoms) ||
        BigInt(route.minimumCreditAtoms) >= 1n << 256n ||
        !/^0x[0-9a-f]{40}$/i.test(route.recipient) ||
        /^0x0{40}$/i.test(route.recipient) ||
        same(route.recipient, owner) ||
        same(route.recipient, request.confidentialAccount) ||
        !Number.isSafeInteger(route.expiresAt) ||
        route.expiresAt * 1000 <= this.now() + 15000 ||
        route.expiresAt * 1000 > this.now() + 600000
      )
        throw new Error("Changed immutable return quote");
      const calls = [transfer(route.recipient, amount)],
        final = await providers.prepare(calls, fees);
      preparedValid(final, s, fees, this.now());
      if (final.feeCap > budget || amount + budget > s.token)
        throw new InfrastructureError(
          409,
          "EARN_RETURN_QUOTE_FEE_CHANGED",
          "The exact quote recipient needs more gas than the approved probe budget. Review a new operation revision.",
        );
      const simulation = await providers.simulate(
        s,
        robinhoodPreparedCalls(final),
        "return",
        amount,
      );
      if (
        simulation.remainingShares !== 0n ||
        simulation.remainingToken !== s.token - amount ||
        simulation.receivedToken !== amount ||
        !simulation.rows.length ||
        simulation.rows.length > 4
      )
        throw new Error("Return transfer simulation failed");
      await providers.assertFresh(s, fees);
      if (this.now() - price.observedAtMs > 300000)
        throw new Error("Return valuation expired");
      const plan: RobinhoodReturnPlan = {
        ...base(request, s, final, fees, budget, this.now()),
        kind: "hoodTokenReturn",
        amountAtoms: amount.toString(),
        confidentialAccount: getAddress(request.confidentialAccount),
        recipient: route.recipient,
        route,
        deadline: Math.min(
          Number(s.block.timestamp + 600n),
          route.expiresAt,
        ).toString(),
        price: {
          tokenPriceMicroUsdc: price.tokenPriceMicroUsdc.toString(),
          observedAtMs: price.observedAtMs,
          maximumAgeMs: 300000,
        },
        maximumResidualUsdcAtoms: residualValue.toString(),
        optimalResidualUpperBound: residualValue < 100000n,
        residualTargetMet: true,
        simulation: simulation.rows.map((row) => ({
          estimatedGas: row.estimatedGas.toString(),
          actualGas: row.actualGas.toString(),
        })),
        quotePolicy: "one-immutable-quote-after-fee-probe",
        completionRequires: [
          "Finalized exact USDG transfer and actual paymaster charge",
          "Authenticated operation-specific confidential credit",
          "Fresh USDG/native/wrapped balances and zero vault shares; combined remainder strictly below 0.50 USDC",
        ],
      };
      plan.expiresAtMs = Math.min(plan.expiresAtMs, route.expiresAt * 1000);
      if (plan.expiresAtMs <= this.now() + 5000)
        throw new Error("Return plan expired");
      plan.planHash = keccak256(stringToHex(JSON.stringify(plan)));
      return freeze(plan);
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      throw new InfrastructureError(
        502,
        "EARN_ROBINHOOD_RETURN_UNAVAILABLE",
        "Could not verify zero shares, fresh USDG valuation, exact return quote and token gas budget. No transaction was sent.",
      );
    }
  }
}
