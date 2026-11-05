import { parseWalletRecoveryStatus, type WalletRecoveryService } from "@/domain/wallet/recovery";
import {
  getStoredWalletRecoverySigner,
  getSignerCapabilities,
  type StoredWalletRecoveryBridge,
} from "./nativeBridge";
export function createWalletRecoveryService(
  getBridge: () => StoredWalletRecoveryBridge | null = getStoredWalletRecoverySigner,
  capabilities: () => Promise<{
    walletRecovery?: boolean;
    walletDiscovery?: boolean;
  }> = getSignerCapabilities,
): WalletRecoveryService {
  async function run(
    walletId: string,
    action: (bridge: StoredWalletRecoveryBridge) => Promise<unknown>,
  ) {
    if (typeof walletId !== "string" || !walletId || walletId.length > 128)
      throw new Error("Select the current wallet before recovery.");
    const bridge = getBridge();
    if (!bridge) throw new Error("Wallet recovery requires the updated native app.");
    try {
      return parseWalletRecoveryStatus(await action(bridge));
    } catch {
      throw new Error("Wallet recovery is unavailable. Check your connection and try again.");
    }
  }
  return {
    async available() {
      try {
        const value = await capabilities();
        const bridge = getBridge();
        return {
          recovery: !!bridge && value.walletRecovery === true,
          discovery: !!bridge && value.walletRecovery === true && value.walletDiscovery === true,
        };
      } catch {
        return { recovery: false, discovery: false };
      }
    },
    status: (id) => run(id, (bridge) => bridge.getWalletRecoveryStatus(id)),
    sync: (id) => run(id, (bridge) => bridge.syncWalletRecovery(id)),
    restore: (id) => run(id, (bridge) => bridge.restoreWalletRecovery(id)),
    discover(id, bound) {
      if (!Number.isSafeInteger(bound) || bound < 0 || bound > 1_000_000)
        return Promise.reject(new Error("Choose a recovery scan bound from 0 to 1000000."));
      return run(id, (bridge) => bridge.discoverWallets(id, bound));
    },
    cancel: (id) => run(id, (bridge) => bridge.cancelWalletDiscovery(id)),
  };
}
