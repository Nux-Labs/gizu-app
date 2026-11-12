import {
  investmentDestination,
  investmentSlotField,
  assertInvestmentSlot,
} from "@/domain/earn/distribution";
import { earnProfiles, type EarnIntent } from "./types";
import { ceilDiv } from "./policy";
export const ethereumEarnRouter = "0x02912516d49dE997db75B9D7858faAE59209650B";
export type VaultKind = "vaultDeposit" | "vaultRedeemAll";
export type VaultPlan = {
  kind: VaultKind;
  operationId: string;
  revision: number;
  owner: string;
  amountAtoms: string;
  shareDecimals: number;
  nonce: number;
  deadline: number;
  gasLimits: number[];
  maxFeePerGasWei: string;
  priorityFeePerGasWei: string;
  maximumGasCostWei: string;
  withdrawalReserveWei: string;
  liquidAtoms: string;
  expiresAtMs: number;
  fusionRequired: boolean;
  bootstrapUsdc: string;
  review?: {
    baseFeeWei?: string;
    quotedAtMs: number;
    referenceBlockNumber: string;
    initialUsdc: string;
    initialEthWei: string;
    extraUsableEthWei?: string;
  };
  fusionFunding?: {
    minimumEthWei: string;
    maximumResolverOverheadWei: string;
    resolverGasPriceWei: string;
  };
};
export type VaultProposal = Omit<
  VaultPlan,
  | "owner"
  | "shareDecimals"
  | "liquidAtoms"
  | "expiresAtMs"
  | "fusionRequired"
  | "bootstrapUsdc"
  | "fusionFunding"
  | "review"
> & {
  walletId: string;
  cycleIndex?: number;
  investmentSlot?: number;
  chainId: 1;
  expectedFrom: string;
  vault: string;
  token: string;
  router: string;
  slippageBps: number;
};
export type VaultOperation = {
  investmentSlot?: number;
  operationId: string;
  revision: number;
  walletId: string;
  kind: VaultKind;
  from: string;
  amountAtoms: string;
  actualFeeWei: string;
  status:
    | "invested"
    | "withdrawn"
    | "residualShares"
    | "reverted"
    | "pending"
    | "cancelled"
    | "needsReview";
  residualShares?: string;
  blocked: boolean;
  canResume: boolean;
  steps: {
    index: number;
    to: string;
    nonce: string;
    status: "planned" | "signed" | "unknown" | "pending" | "finalized" | "reverted";
    nonceConflict: boolean;
    transactionHash?: string;
    actualFeeWei?: string;
  }[];
};
export interface EarnVaultExecutionService {
  available(): Promise<boolean>;
  plan(intent: EarnIntent, kind: VaultKind, signal: AbortSignal): Promise<VaultPlan>;
  list(intent: EarnIntent): Promise<VaultOperation[]>;
  execute(intent: EarnIntent, plan: VaultPlan): Promise<VaultOperation>;
  resume(intent: EarnIntent, operation: VaultOperation): Promise<VaultOperation>;
  cancelUnsigned(intent: EarnIntent, operation: VaultOperation): Promise<VaultOperation>;
  cancel(): void;
}
export function earnObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid earn response.");
  return v as Record<string, unknown>;
}
export function earnAtoms(v: unknown): string {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v) || BigInt(v) >= 1n << 256n)
    throw new Error("Invalid earn quantity.");
  return v;
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Invalid earn integer.");
  return v;
}
function address(v: unknown, expected?: string): string {
  if (
    typeof v !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(v) ||
    /^0x0{40}$/i.test(v) ||
    (expected && v.toLowerCase() !== expected.toLowerCase())
  )
    throw new Error("Earn wallet or contract changed.");
  return v;
}
function hash(v: unknown): string {
  if (typeof v !== "string" || !/^0x[0-9a-f]{64}$/i.test(v) || /^0x0{64}$/i.test(v))
    throw new Error("Invalid earn transaction reference.");
  return v;
}
function id(v: unknown): string {
  if (typeof v !== "string" || !/^[-a-zA-Z0-9_]{1,128}$/.test(v))
    throw new Error("Invalid earn operation.");
  return v;
}
function owner(intent: EarnIntent): string {
  if (
    intent.status !== "prepared" ||
    intent.profileId !== "ethereum-usdc" ||
    investmentDestination(intent).role !== "invest" ||
    investmentDestination(intent).chainId !== 1
  )
    throw new Error("Native Ethereum execution is unavailable for this intent.");
  return address(investmentDestination(intent).address);
}
function gas(v: unknown): number[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 2)
    throw new Error("Invalid earn gas simulation.");
  return v.map((n) => integer(Number(earnAtoms(n)), 21000, 3000000));
}
/** Validate public quote economics; native re-reads state and constructs every call independently. */
export function parseVaultPlan(
  value: unknown,
  intent: EarnIntent,
  kind: VaultKind,
  operationId: string,
  revision: number,
  now: number,
): VaultPlan {
  const row = earnObject(value),
    expected = owner(intent),
    profile = earnProfiles[intent.profileId];
  if (
    row.chainId !== 1 ||
    row.profileId !== intent.profileId ||
    row.operationId !== operationId ||
    row.revision !== revision ||
    row.readOnly !== true ||
    row.executionAvailable !== false
  )
    throw new Error("Earn plan binding changed.");
  address(row.owner, expected);
  address(row.vault, profile.vault);
  address(row.router, ethereumEarnRouter);
  hash(row.referenceBlockHash);
  hash(row.planHash);
  earnAtoms(row.referenceBlockNumber);
  const quoted = integer(row.quotedAtMs),
    reference = integer(row.referenceTimestampMs),
    expires = integer(row.expiresAtMs);
  if (
    quoted > now + 5000 ||
    now - quoted > 60000 ||
    reference > now + 5000 ||
    now - reference > 60000 ||
    expires <= now ||
    expires > quoted + 45000 ||
    expires > reference + 60000
  )
    throw new Error("Earn plan expired. Refresh fees before authorizing.");
  const nonce = integer(Number(earnAtoms(row.nonce))),
    deadline = integer(Number(earnAtoms(row.deadline)));
  if (deadline <= Math.floor(now / 1000) || deadline > Math.floor(now / 1000) + 600)
    throw new Error("Earn deadline expired.");
  let amount: string,
    decimals: number,
    limits: number[],
    fee: string,
    priority: string,
    cost: string,
    reserve: string,
    liquid: string,
    bootstrap = "0",
    fusionRequired = false,
    fusionFunding: VaultPlan["fusionFunding"];
  if (kind === "vaultDeposit") {
    if (
      row.policyVersion !== "ethereum-native-v1-fees8-p25-uppermedian-d10-w30-r2-liquid50000" ||
      row.accountCode !== "0x" ||
      row.existingSharesScope !== "new-position" ||
      row.simulationAvailable !== true
    )
      throw new Error("Unsupported deposit policy or existing position.");
    const assets = earnObject(row.assets),
      usdc = earnObject(assets.usdc),
      shares = earnObject(assets.shares),
      native = earnObject(assets.native),
      weth = earnObject(assets.weth);
    address(usdc.address, profile.token);
    address(shares.address, profile.vault);
    address(weth.address, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    if (
      usdc.decimals !== 6 ||
      native.decimals !== 18 ||
      native.symbol !== "ETH" ||
      weth.decimals !== 18
    )
      throw new Error("Earn asset precision changed.");
    decimals = integer(shares.decimals, 0, 18);
    const balances = earnObject(row.startingBalances);
    if (earnAtoms(balances.shares) !== "0" || earnAtoms(balances.weth) !== "0")
      throw new Error("Existing assets require reconciliation.");
    const startingUsdc = BigInt(earnAtoms(balances.usdc)),
      nativeWei = BigInt(earnAtoms(balances.nativeEth));
    amount = earnAtoms(row.depositAmount);
    liquid = earnAtoms(row.retainedLiquidUsdc);
    const fees = earnObject(row.fees),
      simulation = earnObject(row.simulation);
    if (
      fees.sampleBlocks !== 8 ||
      fees.percentile !== 25 ||
      fees.aggregation !== "upper-median" ||
      fees.depositHeadroomBps !== 1000 ||
      fees.withdrawalHeadroomBps !== 3000 ||
      fees.withdrawalPriceMultiplier !== 2 ||
      simulation.withdrawalPurpose !== "reserve-only-isolated-fork" ||
      simulation.fundingAssumption !== "real-USDC-balance-with-fork-only-native-gas-override"
    )
      throw new Error("Earn fee or reserve policy changed.");
    const rows = (v: unknown, headroom: bigint): number[] => {
      if (!Array.isArray(v) || v.length < 1 || v.length > 2)
        throw new Error("Missing post-deposit gas simulation.");
      return gas(
        v.map((x) => {
          const r = earnObject(x),
            estimated = BigInt(earnAtoms(r.estimatedGas));
          earnAtoms(r.actualGas);
          const limit = earnAtoms(r.gasLimit);
          if (BigInt(limit) !== ceilDiv(estimated * headroom, 100n))
            throw new Error("Gas headroom changed.");
          return limit;
        }),
      );
    };
    limits = rows(simulation.deposit, 110n);
    const withdrawalLimits = rows(simulation.withdrawal, 130n);
    fee = earnAtoms(fees.maximumDepositFeeWei);
    priority = earnAtoms(fees.priorityFeeWei);
    const withdrawalFee = BigInt(earnAtoms(fees.withdrawalReserveFeeWei));
    if (withdrawalFee !== BigInt(fee) * 2n) throw new Error("Withdrawal fee multiplier changed.");
    cost = earnAtoms(row.depositGasBudgetWei);
    reserve = earnAtoms(row.withdrawalReserveWei);
    if (
      BigInt(reserve) !== withdrawalLimits.reduce((a, b) => a + BigInt(b), 0n) * withdrawalFee ||
      BigInt(reserve) === 0n
    )
      throw new Error("Withdrawal reserve changed.");
    let minimumEth = 0n,
      overhead = 0n;
    if (row.fusion !== null) {
      const fusion = earnObject(row.fusion);
      bootstrap = earnAtoms(fusion.inputUsdc);
      minimumEth = BigInt(earnAtoms(fusion.minimumNativeEthWei));
      overhead = BigInt(earnAtoms(fusion.embeddedOverheadWei));
      fusionFunding = {
        minimumEthWei: minimumEth.toString(),
        maximumResolverOverheadWei: overhead.toString(),
        resolverGasPriceWei: fee,
      };
      if (BigInt(bootstrap) === 0n || minimumEth === 0n)
        throw new Error("Invalid ETH funding quote.");
      fusionRequired = true;
    }
    if (
      BigInt(amount) + BigInt(liquid) + BigInt(bootstrap) !== startingUsdc ||
      BigInt(liquid) !== 50000n ||
      nativeWei + minimumEth < BigInt(cost) + BigInt(reserve) ||
      BigInt(earnAtoms(row.totalBudgetWei)) !== BigInt(cost) + BigInt(reserve) + overhead ||
      BigInt(earnAtoms(row.extraUsableEthWei)) !==
        nativeWei + minimumEth - BigInt(cost) - BigInt(reserve)
    )
      throw new Error("Deposit funding or accounting changed.");
  } else {
    if (
      row.kind !== kind ||
      row.returnsQuoted !== false ||
      row.minimumAssetsGuard !== false ||
      row.retainedAfterActionWei !== "0"
    )
      throw new Error("Withdrawal scope changed.");
    address(row.token, profile.token);
    amount = earnAtoms(row.amountAtoms);
    decimals = integer(row.shareDecimals, 0, 18);
    limits = gas(row.gasLimits);
    fee = earnAtoms(row.maxFeePerGasWei);
    priority = earnAtoms(row.priorityFeePerGasWei);
    cost = earnAtoms(row.maximumGasCostWei);
    reserve = "0";
    liquid = earnAtoms(row.startingUsdc);
    if (
      earnAtoms(row.startingShares) !== amount ||
      BigInt(earnAtoms(row.startingNativeWei)) < BigInt(cost)
    )
      throw new Error("Full withdrawal or gas balance changed.");
  }
  if (
    BigInt(amount) === 0n ||
    BigInt(fee) === 0n ||
    BigInt(priority) > BigInt(fee) ||
    BigInt(cost) !== limits.reduce((sum, g) => sum + BigInt(g), 0n) * BigInt(fee)
  )
    throw new Error("Earn gas or amount changed.");
  return {
    kind,
    operationId: id(operationId),
    revision: integer(revision, 1),
    owner: expected,
    amountAtoms: amount,
    shareDecimals: decimals,
    nonce,
    deadline,
    gasLimits: limits,
    maxFeePerGasWei: fee,
    priorityFeePerGasWei: priority,
    maximumGasCostWei: cost,
    withdrawalReserveWei: reserve,
    liquidAtoms: liquid,
    expiresAtMs: expires,
    fusionRequired,
    bootstrapUsdc: bootstrap,
    ...(fusionFunding ? { fusionFunding } : {}),
    review: {
      quotedAtMs: quoted,
      referenceBlockNumber: earnAtoms(row.referenceBlockNumber),
      initialUsdc:
        kind === "vaultDeposit"
          ? earnAtoms(earnObject(row.startingBalances).usdc)
          : earnAtoms(row.startingUsdc),
      initialEthWei:
        kind === "vaultDeposit"
          ? earnAtoms(earnObject(row.startingBalances).nativeEth)
          : earnAtoms(row.startingNativeWei),
      ...(kind === "vaultDeposit"
        ? {
            baseFeeWei: earnAtoms(earnObject(row.fees).baseFeeWei),
            extraUsableEthWei: earnAtoms(row.extraUsableEthWei),
          }
        : {}),
    },
  };
}
export function vaultProposal(plan: VaultPlan, intent: EarnIntent, now: number): VaultProposal {
  if (
    plan.expiresAtMs <= now ||
    plan.deadline <= Math.floor(now / 1000) ||
    plan.fusionRequired ||
    owner(intent).toLowerCase() !== plan.owner.toLowerCase()
  )
    throw new Error("Refresh after confirmed ETH funding before native authorization.");
  const {
    owner: expectedFrom,
    shareDecimals: _shareDecimals,
    liquidAtoms: _liquidAtoms,
    expiresAtMs: _expiresAtMs,
    fusionRequired: _fusionRequired,
    bootstrapUsdc: _bootstrapUsdc,
    fusionFunding: _fusionFunding,
    review: _review,
    ...proposal
  } = plan;
  return {
    ...proposal,
    walletId: intent.walletId,
    ...(intent.cycleIndex ? { cycleIndex: intent.cycleIndex } : {}),
    ...investmentSlotField(intent),
    chainId: 1,
    expectedFrom,
    vault: earnProfiles[intent.profileId].vault,
    token: earnProfiles[intent.profileId].token,
    router: ethereumEarnRouter,
    slippageBps: plan.kind === "vaultDeposit" ? 10 : 0,
  };
}
export function parseVaultOperations(value: unknown, intent: EarnIntent): VaultOperation[] {
  const expected = owner(intent);
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid native earn journal.");
  const seen = new Set<string>();
  return value.map((v) => {
    const row = earnObject(v),
      operationId = id(row.operationId);
    assertInvestmentSlot(row, intent);
    if (
      seen.has(operationId) ||
      row.walletId !== intent.walletId ||
      !(row.kind === "vaultDeposit" || row.kind === "vaultRedeemAll") ||
      typeof row.blocked !== "boolean" ||
      typeof row.canResume !== "boolean" ||
      ![
        "invested",
        "withdrawn",
        "residualShares",
        "reverted",
        "pending",
        "cancelled",
        "needsReview",
      ].includes(String(row.status)) ||
      !Array.isArray(row.steps) ||
      row.steps.length > 4
    )
      throw new Error("Native earn journal binding changed.");
    seen.add(operationId);
    const steps = row.steps.map((v, index) => {
      const s = earnObject(v);
      if (
        s.index !== index ||
        typeof s.nonceConflict !== "boolean" ||
        !["planned", "signed", "unknown", "pending", "finalized", "reverted"].includes(
          String(s.status),
        )
      )
        throw new Error("Invalid native earn step.");
      return {
        index,
        to: address(s.to),
        nonce: earnAtoms(s.nonce),
        status: s.status as VaultOperation["steps"][number]["status"],
        nonceConflict: s.nonceConflict,
        ...(s.transactionHash !== undefined ? { transactionHash: hash(s.transactionHash) } : {}),
        ...(s.actualFeeWei !== undefined ? { actualFeeWei: earnAtoms(s.actualFeeWei) } : {}),
      };
    });
    return {
      operationId,
      revision: integer(row.revision, 1),
      walletId: intent.walletId,
      ...(row.investmentSlot !== undefined ? { investmentSlot: row.investmentSlot as number } : {}),
      kind: row.kind,
      from: address(row.from, expected),
      amountAtoms: earnAtoms(row.amountAtoms),
      actualFeeWei: earnAtoms(row.actualFeeWei),
      blocked: row.blocked,
      canResume: row.canResume,
      status: row.status as VaultOperation["status"],
      ...(row.residualShares !== undefined
        ? { residualShares: earnAtoms(row.residualShares) }
        : {}),
      steps,
    };
  });
}
