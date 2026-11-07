import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
export type GasFailureCode =
  | "GAS_APPROVAL_UNSTABLE"
  | "GAS_BUDGET_EXCEEDED"
  | "GAS_ESTIMATE_REJECTED"
  | "GAS_STATE_CHANGED"
  | "GAS_TERMS_CHANGED";
export class GasPolicyError extends InfrastructureError {
  readonly retryable = false;
  constructor(code: GasFailureCode, message: string) {
    super(
      code === "GAS_STATE_CHANGED" || code === "GAS_TERMS_CHANGED" ? 409 : 422,
      code,
      message,
    );
  }
}
/** Classify deterministic RPC validation failures without exposing provider error text. */
export function deterministicGasError(
  error: unknown,
): GasPolicyError | undefined {
  if (error instanceof GasPolicyError) return error;
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    if (
      /\bAA\d{2}\b|execution reverted|insufficient (?:funds|balance|allowance)|gas (?:limit|estimation).*?(?:exceed|fail)|paymaster.*?(?:reject|expired)/i.test(
        cause.message,
      )
    )
      return new GasPolicyError(
        "GAS_ESTIMATE_REJECTED",
        "The exact operation did not pass gas and sponsorship validation. Review fresh operation terms.",
      );
    cause = cause.cause;
  }
  return undefined;
}
