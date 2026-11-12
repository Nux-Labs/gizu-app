export type ExitSnapshotStage =
  | "request-validate"
  | "chain-read"
  | "reference-validate"
  | "prices-fetch"
  | "prices-validate"
  | "canonical-check"
  | "valuation"
  | "freshness";

type Details = {
  asset?: "token" | "usdc" | "native";
  priceAgeMs?: number;
  priceMaxAgeMs?: number;
  httpStatus?: number;
};
const reasons = new Map([
  ["Invalid exit request", "invalid-request"],
  ["Exit RPC unavailable", "rpc-unavailable"],
  ["Missing block hash", "missing-block-hash"],
  ["Asset contract changed", "contract-metadata"],
  ["Invalid exit reference", "invalid-reference"],
  ["Exit prices unavailable", "prices-unconfigured"],
  ["Missing response body", "provider-body-missing"],
  ["Response too large", "provider-body-too-large"],
  ["Invalid provider response", "provider-response-format"],
  ["Provider unavailable", "provider-http"],
  ["Invalid exit data", "invalid-registry-row"],
  ["Invalid price registry", "invalid-price-registry"],
  ["Missing or duplicate asset price", "missing-or-duplicate-price"],
  ["Asset registry changed", "asset-metadata"],
  ["Asset price expired", "price-expired"],
  ["Invalid asset price", "invalid-price"],
  ["Invalid asset price precision", "invalid-price-precision"],
  ["Exit reference changed", "reference-changed"],
  ["Exit snapshot expired", "snapshot-expired"],
]);
const errorTypes = new Set([
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "RpcRequestError",
  "HttpRequestError",
  "ContractFunctionExecutionError",
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
  "UnknownRpcError",
]);
const transportCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Only fixed labels and numeric codes survive; raw errors, URLs and payloads do not. */
export class ExitSnapshotFailure extends Error {
  readonly diagnostic;
  constructor(stage: ExitSnapshotStage, cause: unknown, details: Details = {}) {
    super("Fresh investment-wallet exit snapshot unavailable");
    let reason = "unclassified";
    let errorType: string | undefined;
    let transportCode: string | undefined;
    let httpStatus = details.httpStatus;
    let rpcCode: number | undefined;
    let current = cause;
    for (
      let depth = 0;
      depth < 16 && current && typeof current === "object";
      depth++
    ) {
      const row = current as Record<string, unknown>;
      if (current instanceof Error)
        reason = reasons.get(current.message) ?? reason;
      if (typeof row.name === "string" && errorTypes.has(row.name))
        errorType ??= row.name;
      if (typeof row.code === "string" && transportCodes.has(row.code))
        transportCode ??= row.code;
      if (
        Number.isInteger(row.status) &&
        Number(row.status) >= 100 &&
        Number(row.status) <= 599
      )
        httpStatus ??= Number(row.status);
      if (
        Number.isSafeInteger(row.code) &&
        ((Number(row.code) < 0 && Number(row.code) >= -32768) ||
          row.code === 429)
      )
        rpcCode ??= Number(row.code);
      if (row.code === 429 || row.status === 429) reason = "provider-throttled";
      current = row.cause;
    }
    if (stage === "prices-fetch" && errorType === "SyntaxError")
      reason = "provider-response-json";
    this.diagnostic = Object.freeze({
      stage,
      reason,
      ...(details.asset ? { asset: details.asset } : {}),
      ...(Number.isSafeInteger(details.priceAgeMs)
        ? { priceAgeMs: details.priceAgeMs }
        : {}),
      ...(details.priceMaxAgeMs !== undefined
        ? { priceMaxAgeMs: details.priceMaxAgeMs }
        : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(rpcCode !== undefined ? { rpcCode } : {}),
      ...(errorType ? { errorType } : {}),
      ...(transportCode ? { transportCode } : {}),
    });
  }
}
