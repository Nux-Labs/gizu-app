import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { GasPolicyError } from "./gas-errors.ts";
import {
  fundingApproval,
  fundingApprovalUpperBound,
  uint256,
  type TokenGasOperation,
} from "./gas-policy.ts";
export type PaymasterOperation = TokenGasOperation & {
  callData: Hex;
  paymaster?: Address;
};
export type PaymasterCall = { to: Address; data?: Hex; value?: bigint };
type Sponsorship = {
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
};
type GasEstimate = {
  callGasLimit: bigint;
  preVerificationGas: bigint;
  verificationGasLimit: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
};
/** Refreshing sponsorship can change the operation being estimated. Estimate it again. */
export async function estimateWithFreshPaymaster<T extends PaymasterOperation>(
  initial: T,
  estimate: (operation: T) => Promise<GasEstimate>,
  refresh: (operation: T) => Promise<Sponsorship>,
): Promise<T> {
  let operation = initial;
  const cover = (provided: unknown, measured: unknown, positive = false) => {
    const previous = uint256(provided, positive),
      latest = uint256(measured, positive);
    return latest > previous ? latest : previous;
  };
  const gasFields = [
    "callGasLimit",
    "preVerificationGas",
    "verificationGasLimit",
    "paymasterPostOpGasLimit",
    "paymasterVerificationGasLimit",
  ] as const;
  for (let attempt = 0; attempt < 4; attempt++) {
    const stub = await refresh(operation);
    if (
      !stub.paymaster ||
      !stub.paymasterData ||
      ("paymasterAndData" in stub && stub.paymasterAndData !== undefined)
    )
      throw new GasPolicyError(
        "GAS_TERMS_CHANGED",
        "Unexpected token sponsorship format",
      );
    const sponsored = {
      ...operation,
      paymaster: stub.paymaster,
      paymasterData: stub.paymasterData,
      paymasterPostOpGasLimit: uint256(
        stub.paymasterPostOpGasLimit ?? operation.paymasterPostOpGasLimit,
      ),
      paymasterVerificationGasLimit: uint256(
        stub.paymasterVerificationGasLimit ??
          operation.paymasterVerificationGasLimit,
      ),
    };
    const gas = await estimate(sponsored);
    const next = {
      ...sponsored,
      callGasLimit: cover(sponsored.callGasLimit, gas.callGasLimit, true),
      preVerificationGas: cover(
        sponsored.preVerificationGas,
        gas.preVerificationGas,
        true,
      ),
      verificationGasLimit: cover(
        sponsored.verificationGasLimit,
        gas.verificationGasLimit,
        true,
      ),
      paymasterPostOpGasLimit: cover(
        sponsored.paymasterPostOpGasLimit,
        gas.paymasterPostOpGasLimit ?? sponsored.paymasterPostOpGasLimit,
      ),
      paymasterVerificationGasLimit: cover(
        sponsored.paymasterVerificationGasLimit,
        gas.paymasterVerificationGasLimit ??
          sponsored.paymasterVerificationGasLimit,
      ),
    };
    // Sponsorship was refreshed for these gas fields and its exact data was estimated.
    // Keep measured headroom when a later estimate falls. Returning the supplied limits
    // unchanged preserves every field covered by a final paymaster signature.
    if (gasFields.every((key) => next[key] === sponsored[key])) return next;
    operation = next;
  }
  throw new GasPolicyError(
    "GAS_APPROVAL_UNSTABLE",
    "Token sponsorship did not stabilize",
  );
}
/** Rebuild only the allowed business calls and a narrowly bounded fee approval. */
export async function stabilizePaymasterApproval<
  T extends PaymasterOperation,
>(input: {
  initial: T;
  calls: PaymasterCall[];
  allowance: bigint;
  token: Address;
  paymaster: Address;
  cap: (operation: T) => bigint;
  encode: (calls: PaymasterCall[]) => Promise<Hex>;
  estimate: (operation: T) => Promise<T>;
  assertBudget?: (cap: bigint) => void;
  approval?: (cap: bigint) => bigint;
  approvalUpperBound?: (cap: bigint) => bigint;
}): Promise<T> {
  uint256(input.allowance);
  let operation = input.initial;
  const approvalFor = input.approval ?? ((cap) => fundingApproval(cap, "earn"));
  const approvalUpperBound =
    input.approvalUpperBound ??
    ((cap) => fundingApprovalUpperBound(cap, "earn"));
  for (let attempt = 0; attempt < 4; attempt++) {
    const cap = uint256(input.cap(operation), true),
      approval = uint256(approvalFor(cap), true);
    if (approval < cap || approval > approvalUpperBound(cap))
      throw new GasPolicyError(
        "GAS_TERMS_CHANGED",
        "Token approval policy exceeds its bound",
      );
    input.assertBudget?.(cap);
    const needsApproval = input.allowance < cap;
    const calls = needsApproval
      ? [
          {
            to: input.token,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [input.paymaster, approval],
            }),
          },
          ...input.calls,
        ]
      : input.calls;
    const callData = await input.encode(calls);
    const next = await input.estimate({ ...operation, callData });
    if (next.callData !== callData)
      throw new GasPolicyError(
        "GAS_TERMS_CHANGED",
        "Estimator changed token calldata",
      );
    const checked = uint256(input.cap(next), true);
    input.assertBudget?.(checked);
    if (
      needsApproval
        ? approval >= checked && approval <= approvalUpperBound(checked)
        : input.allowance >= checked
    )
      return next;
    operation = next;
  }
  throw new GasPolicyError(
    "GAS_APPROVAL_UNSTABLE",
    "Conservative token approval did not stabilize",
  );
}
