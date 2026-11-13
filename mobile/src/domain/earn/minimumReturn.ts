import { monadConfidentialUsdcAssetId, earnReturnAddress, type EarnIntent } from "./types";
import { earnAtoms, earnObject } from "./vaultExecution";

/** Public native evidence of a minimum return, never an exact credit or spending allowance. */
export type MinimumReturnReceipt = {
  operationId: string;
  revision: number;
  confidentialAddress: string;
  assetId: string;
  depositAddress: string;
  transactionHash: string;
  verifiedMinimumAtoms: string;
  status: "minimumReceived";
  verification: "minimum-return-v1";
  observedAtMs: number;
  timestampMs: number;
  authenticated: true;
  operationScoped: true;
  spendingAuthorized: false;
  exactAmountKnown: false;
};
const fields = [
  "operationId",
  "revision",
  "confidentialAddress",
  "assetId",
  "depositAddress",
  "transactionHash",
  "verifiedMinimumAtoms",
  "status",
  "verification",
  "observedAtMs",
  "timestampMs",
  "authenticated",
  "operationScoped",
  "spendingAuthorized",
  "exactAmountKnown",
];
const same = (v: unknown, expected: unknown) =>
  typeof v === "string" &&
  typeof expected === "string" &&
  v.toLowerCase() === expected.toLowerCase();
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Only consume native journal results: native binds the deposit address to its saved route. */
export function parseMinimumReturn(
  row: Record<string, unknown>,
  intent: EarnIntent,
): MinimumReturnReceipt | undefined {
  const present =
    row.status === "minimumReceived" ||
    row.minimumReturnReceipt !== undefined ||
    row.verifiedMinimumAtoms !== undefined ||
    row.minimumReturnEnvelope !== undefined;
  if (!present) return undefined;
  if (
    row.status !== "minimumReceived" ||
    !(intent.profileId === "robinhood-usdg"
      ? row.kind === "hoodTokenReturn"
      : row.kind === "returnUsdc" || row.kind === "returnEth") ||
    row.creditedAtoms !== undefined ||
    row.settlement !== undefined ||
    row.minimumReturnEnvelope !== undefined ||
    row.blocked !== false ||
    row.canResume !== false
  )
    throw Error("Invalid native minimum return evidence.");
  const r = earnObject(row.minimumReturnReceipt);
  const minimum = earnAtoms(row.verifiedMinimumAtoms);
  if (
    Object.keys(r).some((key) => !fields.includes(key)) ||
    r.operationId !== row.operationId ||
    !integer(r.revision) ||
    r.revision < 1 ||
    !integer(row.revision) ||
    r.revision >= row.revision ||
    (!same(r.confidentialAddress, intent.confidentialAddress) &&
      !same(r.confidentialAddress, earnReturnAddress(intent))) ||
    r.assetId !== monadConfidentialUsdcAssetId ||
    typeof r.depositAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(r.depositAddress) ||
    /^0x0{40}$/i.test(r.depositAddress) ||
    typeof r.transactionHash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(r.transactionHash) ||
    /^0x0{64}$/i.test(r.transactionHash) ||
    !same(r.transactionHash, row.transactionHash) ||
    r.verifiedMinimumAtoms !== minimum ||
    minimum === "0" ||
    r.status !== "minimumReceived" ||
    r.verification !== "minimum-return-v1" ||
    r.authenticated !== true ||
    r.operationScoped !== true ||
    r.spendingAuthorized !== false ||
    r.exactAmountKnown !== false ||
    !integer(r.observedAtMs) ||
    !integer(r.timestampMs) ||
    r.observedAtMs > r.timestampMs + 5000
  )
    throw Error("Invalid native minimum return evidence.");
  return r as MinimumReturnReceipt;
}
