export type WalletRecoveryStatus = {
  version: 1;
  phase: "idle" | "syncing" | "restoring" | "discovering" | "paused" | "ready" | "error";
  revision: number;
  synced: boolean;
  scannedThroughCycle: number;
  scanTargetCycle: number;
  discoveredWallets: number;
  recoveryRequired: boolean;
  messageCode?: string;
};
export type WalletRecoveryCapabilities = { recovery: boolean; discovery: boolean };
export interface WalletRecoveryService {
  available(): Promise<WalletRecoveryCapabilities>;
  status(walletId: string): Promise<WalletRecoveryStatus>;
  sync(walletId: string): Promise<WalletRecoveryStatus>;
  restore(walletId: string): Promise<WalletRecoveryStatus>;
  discover(walletId: string, throughCycle: number): Promise<WalletRecoveryStatus>;
  cancel(walletId: string): Promise<WalletRecoveryStatus>;
}
export function parseWalletRecoveryStatus(value: unknown): WalletRecoveryStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid wallet recovery status.");
  const row = value as Record<string, unknown>;
  const integer = (key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const n = row[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < minimum || n > maximum)
      throw new Error("Invalid wallet recovery progress.");
    return n;
  };
  const phases: WalletRecoveryStatus["phase"][] = [
    "idle",
    "syncing",
    "restoring",
    "discovering",
    "paused",
    "ready",
    "error",
  ];
  if (
    row.version !== 1 ||
    !phases.includes(row.phase as WalletRecoveryStatus["phase"]) ||
    typeof row.synced !== "boolean" ||
    typeof row.recoveryRequired !== "boolean"
  )
    throw new Error("Invalid wallet recovery status.");
  const revision = integer("revision", 0);
  const scannedThroughCycle = integer("scannedThroughCycle", -1, 1_000_000);
  const scanTargetCycle = integer("scanTargetCycle", -1, 1_000_000);
  if (scannedThroughCycle > scanTargetCycle || (row.synced && revision === 0))
    throw new Error("Invalid wallet recovery progress.");
  const messageCodes = [
    "backupUnavailable",
    "conflict",
    "tampered",
    "rollback",
    "reconciliationRequired",
    "scanIncomplete",
    "cancelled",
    "storageUnavailable",
  ];
  return {
    version: 1,
    phase: row.phase as WalletRecoveryStatus["phase"],
    revision,
    synced: row.synced,
    scannedThroughCycle,
    scanTargetCycle,
    discoveredWallets: integer("discoveredWallets", 0),
    recoveryRequired: row.recoveryRequired,
    ...(typeof row.messageCode === "string" && messageCodes.includes(row.messageCode)
      ? { messageCode: row.messageCode }
      : {}),
  };
}
export function recoveryScanBound(text: string): number | null {
  if (!/^(0|[1-9][0-9]{0,6})$/.test(text)) return null;
  const value = Number(text);
  return value <= 1_000_000 ? value : null;
}
