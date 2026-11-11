import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";

type PlanStage =
  | "read-state"
  | "fee-market"
  | "vault-simulation"
  | "deposit-sponsorship"
  | "withdrawal-sponsorship"
  | "final-sponsorship"
  | "freshness"
  | "plan-validation";

const reasons = new Map([
  ["Fork unavailable", "fork-unavailable"],
  ["Fork startup unavailable", "fork-startup"],
  ["Fork reference disagreement", "fork-reference"],
  ["Fork capacity unavailable", "fork-capacity"],
  ["Fork simulation timed out", "fork-timeout"],
  ["Changed USDG funded state", "funded-state"],
  ["Exact vault call reverted", "vault-revert"],
  ["No simulated USDG shares", "missing-shares"],
  ["USDG simulation redemption left shares", "redemption-shares"],
  ["Insufficient or stale USDG budget", "stale-budget"],
  ["Insufficient USDG gas reserve", "gas-reserve"],
  ["Final USDG cap exceeds deposit budget", "final-fee-cap"],
  ["Robinhood state/fees changed", "state-or-fees-changed"],
  ["Robinhood plan expired", "plan-expired"],
  ["USDG deposit funding did not converge", "budget-convergence"],
  ["USDG paymaster unavailable", "paymaster-unavailable"],
  ["Read-only USDG preview cannot sign", "unexpected-signing-request"],
  ["Unknown Robinhood delegation", "account-delegation"],
  ["Unsupported USDG sponsorship", "unsupported-sponsorship"],
  ["Invalid USDG fees", "fee-market-values"],
  ["USDG operation identity/fee changed", "operation-identity-or-fees"],
  ["USDG vault calls changed", "vault-calls"],
  ["Unknown USDG approval", "approval-target"],
  ["USDG approval exceeds cap", "approval-cap"],
  ["USDG allowance insufficient", "approval-allowance"],
  ["Unexpected USDG factory", "account-factory"],
  ["Pending Robinhood nonce", "pending-nonce"],
  ["Changed Robinhood authorization binding", "authorization-binding"],
  ["Invalid gas quantity", "gas-quantity"],
  ["Malformed token paymaster data", "paymaster-format"],
  ["Unsupported paymaster mode or token", "paymaster-mode-or-token"],
  ["Invalid token gas prices", "gas-prices"],
  ["Expired token paymaster terms", "paymaster-expiry"],
]);
const errorTypes = new Set([
  "TypeError",
  "RangeError",
  "RpcRequestError",
  "HttpRequestError",
  "TimeoutError",
  "UserOperationExecutionError",
  "ExecutionRevertedError",
  "ContractFunctionExecutionError",
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
  "UnknownRpcError",
  "InvalidInputRpcError",
  "EstimateGasExecutionError",
  "InvalidAddressError",
]);

/** Fixed labels and numeric transport codes only. Never serialize an upstream error. */
export class RobinhoodPlanFailure extends InfrastructureError {
  readonly diagnostic: Readonly<{
    stage: PlanStage;
    reason: string;
    httpStatus?: number;
    rpcCode?: number;
    accountAbstractionCode?: string;
    errorType?: string;
    codeLocation?: string;
  }>;

  constructor(stage: PlanStage, cause: unknown) {
    super(
      502,
      "EARN_ROBINHOOD_PLAN_UNAVAILABLE",
      "Could not verify a fresh USDG deposit, token gas sponsorship and post-deposit redemption simulation. Execution remains unavailable.",
    );
    let current = cause;
    let reason = "unclassified";
    let httpStatus: number | undefined;
    let rpcCode: number | undefined;
    let accountAbstractionCode: string | undefined;
    let errorType: string | undefined;
    let codeLocation: string | undefined;
    for (let depth = 0; depth < 16 && current instanceof Error; depth++) {
      reason = reasons.get(current.message) ?? reason;
      if (
        ("code" in current && current.code === 429) ||
        ("status" in current && current.status === 429)
      )
        reason = "rpc-throttled";
      accountAbstractionCode ??= current.message
        .slice(0, 8192)
        .match(/\bAA[0-9]{2}\b/)?.[0];
      if (errorTypes.has(current.name)) errorType ??= current.name;
      if (codeLocation === undefined) {
        for (const line of (current.stack ?? "").slice(-16384).split("\n")) {
          if (!/^\s+at\s/.test(line)) continue;
          const frame = line.match(
            /\/backend\/(?:src|dist)\/adapters\/(?:earn\/(robinhood-paymaster|robinhood-simulation|fork-simulation)|evm\/(gas-policy|token-paymaster))\.(ts|js):([1-9][0-9]{0,4}):[1-9][0-9]*\)?$/,
          );
          if (frame) {
            codeLocation = `${frame[1] ?? frame[2]}.${frame[3]}:${frame[4]}`;
            break;
          }
        }
      }
      if (
        "status" in current &&
        Number.isInteger(current.status) &&
        Number(current.status) >= 100 &&
        Number(current.status) <= 599
      )
        httpStatus ??= Number(current.status);
      if (
        "code" in current &&
        Number.isSafeInteger(current.code) &&
        ((Number(current.code) < 0 && Number(current.code) >= -32768) ||
          current.code === 429)
      )
        rpcCode ??= Number(current.code);
      current = current.cause;
    }
    this.diagnostic = Object.freeze({
      stage,
      reason,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(rpcCode !== undefined ? { rpcCode } : {}),
      ...(accountAbstractionCode !== undefined
        ? { accountAbstractionCode }
        : {}),
      ...(errorType !== undefined ? { errorType } : {}),
      ...(codeLocation !== undefined ? { codeLocation } : {}),
    });
  }
}

export async function robinhoodPlanStage<T>(
  stage: PlanStage,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InfrastructureError) throw error;
    throw new RobinhoodPlanFailure(stage, error);
  }
}
