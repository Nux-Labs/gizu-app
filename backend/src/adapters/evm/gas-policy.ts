/** Integer EVM fee arithmetic. Rounding is a policy decision, never implicit. */
export type Rounding = "floor" | "ceil";
export const UINT256_MAX = (1n << 256n) - 1n;
export function uint256(value: unknown, positive = false): bigint {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > UINT256_MAX ||
    (positive && value === 0n)
  )
    throw new Error("Invalid gas quantity");
  return value;
}
export function ceilDiv(a: bigint, b: bigint): bigint {
  uint256(a);
  uint256(b, true);
  return (a + b - 1n) / b;
}
export function mulDiv(
  a: bigint,
  b: bigint,
  denominator: bigint,
  rounding: Rounding,
): bigint {
  uint256(a);
  uint256(b);
  uint256(denominator, true);
  if (rounding !== "floor" && rounding !== "ceil")
    throw new Error("Invalid gas rounding");
  const product = uint256(a * b);
  return uint256(
    (product + (rounding === "ceil" ? denominator - 1n : 0n)) / denominator,
  );
}
export function nativeGasCost(gas: bigint, maxFeePerGas: bigint): bigint {
  return mulDiv(uint256(gas, true), uint256(maxFeePerGas, true), 1n, "floor");
}
export const gasFields = [
  "preVerificationGas",
  "callGasLimit",
  "verificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterVerificationGasLimit",
] as const;
export type TokenGasOperation = Partial<
  Record<(typeof gasFields)[number], bigint>
> & {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterData?: `0x${string}`;
};
export function parseTokenPaymasterData(data: unknown, token: string) {
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-f]{364,8192}$/i.test(data) ||
    data.length % 2 !== 0 ||
    !/^0x[0-9a-f]{40}$/i.test(token)
  )
    throw new Error("Malformed token paymaster data");
  const raw = data.slice(2).toLowerCase();
  if (
    !["02", "03"].includes(raw.slice(0, 2)) ||
    raw.slice(2, 4) !== "00" ||
    `0x${raw.slice(28, 68)}` !== token.toLowerCase()
  )
    throw new Error("Unsupported paymaster mode or token");
  return {
    validUntil: BigInt(`0x${raw.slice(4, 16)}`),
    validAfter: BigInt(`0x${raw.slice(16, 28)}`),
    postOpGas: uint256(BigInt(`0x${raw.slice(68, 100)}`)),
    exchangeRate: uint256(BigInt(`0x${raw.slice(100, 164)}`), true),
  };
}
/** Protocol charge uses floor; conservative Earn reserves use ceiling explicitly. */
export function erc20PaymasterCap(
  operation: TokenGasOperation,
  policy: { token: string; rounding: Rounding },
): bigint {
  const data = parseTokenPaymasterData(operation.paymasterData, policy.token);
  const fee = uint256(operation.maxFeePerGas, true);
  if (uint256(operation.maxPriorityFeePerGas) > fee)
    throw new Error("Invalid token gas prices");
  const gas = uint256(
    gasFields.reduce((sum, field) => sum + uint256(operation[field]), 0n),
    true,
  );
  const native = uint256((gas + data.postOpGas) * fee);
  return mulDiv(native, data.exchangeRate, 10n ** 18n, policy.rounding);
}
export type FundingProfile = "earn" | "swap";
function assertFundingProfile(profile: FundingProfile) {
  if (profile !== "earn" && profile !== "swap")
    throw new Error("Unsupported funding fee profile");
}
/** Preserve each native signing contract: Earn reviews a ceiling; legacy Swap signs the protocol floor. */
export function fundingFeeCap(
  operation: TokenGasOperation,
  token: string,
  profile: FundingProfile,
): bigint {
  assertFundingProfile(profile);
  return erc20PaymasterCap(operation, {
    token,
    rounding: profile === "swap" ? "floor" : "ceil",
  });
}
export function fundingApprovalUpperBound(
  cap: bigint,
  profile: FundingProfile,
): bigint {
  uint256(cap, true);
  assertFundingProfile(profile);
  return profile === "swap"
    ? uint256(cap + cap / 50n)
    : mulDiv(cap, 101n, 100n, "ceil");
}
/** The legacy Swap 2% bound floors its increment: small caps cannot approve even one extra atom. */
export function fundingApproval(cap: bigint, profile: FundingProfile): bigint {
  const upperBound = fundingApprovalUpperBound(cap, profile);
  const target = mulDiv(cap, 101n, 100n, "ceil");
  return target > upperBound ? upperBound : target;
}
/** A feasible reserve never shrinks while calldata and provider quotes change. */
export function feeEnvelope(
  previousBudget: bigint,
  quotedCap: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  uint256(previousBudget);
  const budget = mulDiv(
    uint256(quotedCap, true),
    numerator,
    denominator,
    "ceil",
  );
  return budget > previousBudget ? budget : previousBudget;
}

export function assertPaymasterValidity(
  data: unknown,
  token: string,
  nowSeconds: bigint,
  minimumRemainingSeconds = 15n,
  clockSkewSeconds = 0n,
) {
  uint256(nowSeconds);
  uint256(minimumRemainingSeconds);
  uint256(clockSkewSeconds);
  const terms = parseTokenPaymasterData(data, token);
  if (
    terms.validAfter > nowSeconds + clockSkewSeconds ||
    (terms.validUntil !== 0n &&
      terms.validUntil <= nowSeconds + minimumRemainingSeconds)
  )
    throw new Error("Expired token paymaster terms");
  return terms;
}
