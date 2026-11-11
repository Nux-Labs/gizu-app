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
]);

/** Fixed labels and numeric transport codes only. Never serialize an upstream error. */
export class RobinhoodPlanFailure extends InfrastructureError {
  readonly diagnostic: Readonly<{
    stage: PlanStage;
    reason: string;
    httpStatus?: number;
    rpcCode?: number;
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
    for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
      reason = reasons.get(current.message) ?? reason;
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
        Number(current.code) < 0 &&
        Number(current.code) >= -32768
      )
        rpcCode ??= Number(current.code);
      current = current.cause;
    }
    this.diagnostic = Object.freeze({
      stage,
      reason,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(rpcCode !== undefined ? { rpcCode } : {}),
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
