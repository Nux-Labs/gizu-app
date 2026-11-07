/** Versioned Ethereum policy: all amounts are integer base units. */
export const POLICY_VERSION =
  "ethereum-native-v1-fees8-p25-uppermedian-d10-w30-r2-liquid50000" as const;
export type ReferenceBlock = {
  number: bigint;
  hash: string;
  timestamp: bigint;
  baseFeePerGas: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
};
import { ceilDiv, mulDiv, nativeGasCost } from "../evm/gas-policy.ts";
export { ceilDiv } from "../evm/gas-policy.ts";
export function nextBaseFee(b: ReferenceBlock): bigint {
  if (
    b.baseFeePerGas < 0n ||
    b.gasLimit < 2n ||
    b.gasUsed < 0n ||
    b.gasUsed > b.gasLimit
  )
    throw new Error("Invalid block gas");
  const target = b.gasLimit / 2n,
    diff =
      (b.baseFeePerGas *
        (b.gasUsed > target ? b.gasUsed - target : target - b.gasUsed)) /
      target /
      8n;
  return b.gasUsed === target
    ? b.baseFeePerGas
    : b.gasUsed < target
      ? b.baseFeePerGas - diff
      : b.baseFeePerGas + (diff > 0n ? diff : 1n);
}
export function feePolicy(block: ReferenceBlock, tips: bigint[]) {
  if (tips.length !== 8 || tips.some((t) => t < 0n))
    throw new Error("Expected eight fee samples");
  const sorted = [...tips].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    median = sorted[4]!;
  const priorityFee = median > 10000n ? median : 10000n,
    next = nextBaseFee(block);
  const depositFee = next + (next / 8n > 0n ? next / 8n : 1n) + priorityFee;
  return { block, priorityFee, depositFee, withdrawFee: depositFee * 2n };
}
export type Fees = ReturnType<typeof feePolicy>;
export function gasBudget(
  depositGas: bigint[],
  withdrawGas: bigint[],
  fees: Fees,
) {
  const limits = (gas: bigint[], pct: bigint) => {
    if (!gas.length || gas.some((g) => g <= 0n))
      throw new Error("Missing measured gas");
    return gas.map((g) => mulDiv(g, pct, 100n, "ceil"));
  };
  const depositLimits = limits(depositGas, 110n),
    withdrawLimits = limits(withdrawGas, 130n);
  const depositWei =
      nativeGasCost(depositLimits.reduce((a, b) => a + b, 0n), fees.depositFee),
    withdrawWei = nativeGasCost(withdrawLimits.reduce((a, b) => a + b, 0n), fees.withdrawFee);
  return {
    depositLimits,
    withdrawLimits,
    depositWei,
    withdrawWei,
    totalWei: depositWei + withdrawWei,
  };
}
export type ResolverEconomics = {
  estimatedGas: bigint;
  gasUnits: bigint;
  gasPrice: bigint;
  gasCostWei: bigint;
  profitWei: bigint;
  allowanceWei: bigint;
  inputValueWei: bigint;
  maximumGrossEth: bigint;
};
function uint(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    value = String(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 78)
    throw new Error("Invalid provider integer");
  return BigInt(value);
}
function price(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^\d+(\.\d{1,18})?$/.test(value) ||
    value.length > 50
  )
    throw new Error("Invalid token price");
  const [a, b = ""] = value.split(".");
  const n = BigInt(a!) * 10n ** 18n + BigInt(b.padEnd(18, "0"));
  if (n <= 0n) throw new Error("Invalid token price");
  return n;
}
export function resolverBudget(
  response: {
    gas?: unknown;
    gasLimit?: unknown;
    prices?: { usd?: { fromToken?: unknown; toToken?: unknown } };
  },
  input: bigint,
  gasPrice: bigint,
): ResolverEconomics {
  const estimates = [response.gas, response.gasLimit]
    .filter((v) => v !== undefined)
    .map(uint);
  if (
    !estimates.length ||
    estimates.some((g) => g <= 0n) ||
    input <= 0n ||
    gasPrice <= 0n
  )
    throw new Error("Missing positive resolver gas estimate");
  const estimatedGas = estimates.reduce((a, b) => (a > b ? a : b), 202859n),
    gasUnits = mulDiv(estimatedGas, 120n, 100n, "ceil"),
    budgetGasPrice = mulDiv(gasPrice, 125n, 100n, "ceil");
  const gasCostWei = nativeGasCost(gasUnits, budgetGasPrice),
    profitWei = ceilDiv(gasCostWei, 10n),
    allowanceWei = gasCostWei + profitWei;
  const inputValueWei =
    (input * price(response.prices?.usd?.fromToken) * 10n ** 12n) /
    price(response.prices?.usd?.toToken);
  return {
    estimatedGas,
    gasUnits,
    gasPrice: budgetGasPrice,
    gasCostWei,
    profitWei,
    allowanceWei,
    inputValueWei,
    maximumGrossEth: inputValueWei - allowanceWei,
  };
}
export type BootstrapQuote = {
  input: bigint;
  minimumEth: bigint;
  economics?: ResolverEconomics;
};
export async function selectBootstrapQuote<T extends BootstrapQuote>({
  requiredEth,
  maxInput,
  initialInput,
  quote,
}: {
  requiredEth: bigint;
  maxInput: bigint;
  initialInput: bigint;
  quote: (input: bigint) => Promise<T>;
}): Promise<T> {
  if (requiredEth <= 0n || maxInput <= 0n || initialInput <= 0n)
    throw new Error("Invalid bootstrap funding");
  let input = initialInput < maxInput ? initialInput : maxInput;
  for (let i = 0; i < 8; i++) {
    let result: T;
    try {
      result = await quote(input);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "FUSION_AMOUNT_TOO_SMALL"
      )
        throw error;
      if (input === maxInput)
        throw new Error("Insufficient affordable Fusion output");
      input = input * 2n > maxInput ? maxInput : input * 2n;
      continue;
    }
    if (result.input !== input) throw new Error("Quote input changed");
    if (result.minimumEth <= 0n)
      throw new Error("Invalid minimum native output");
    if (result.minimumEth >= requiredEth) return result;
    if (input === maxInput)
      throw new Error("Insufficient affordable Fusion output");
    const next =
      result.economics && result.economics.inputValueWei > 0n
        ? ceilDiv(
            (input +
              ceilDiv(
                (requiredEth - result.minimumEth) * input,
                result.economics.inputValueWei,
              )) *
              101n,
            100n,
          )
        : ceilDiv(input * requiredEth * 101n, result.minimumEth * 100n);
    input = next > maxInput ? maxInput : next;
  }
  throw new Error("Fusion funding did not converge");
}
