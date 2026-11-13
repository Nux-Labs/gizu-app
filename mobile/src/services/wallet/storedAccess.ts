import type { AccessService, WalletSession } from "../access";
import type { StoredSignerContract, StoredWalletState } from "@/domain/wallet/storedSigner";
import { WalletUnavailableError } from "./nativeBridge";

export type StoredWalletBridge = Pick<
  StoredSignerContract,
  | "getWalletState"
  | "createWallet"
  | "openWallet"
  | "backupWallet"
  | "restoreWallet"
  | "getSwapDeposit"
  | "lock"
  | "cancelWalletOperation"
>;

async function session(
  state: StoredWalletState,
  native: StoredWalletBridge,
): Promise<WalletSession> {
  if (state.status !== "ready" || !/^[0-9a-f-]{36}$/i.test(state.walletId))
    throw new Error("Verified backup required");
  const account = state.accounts?.find((item) => item.accountIndex === 0);
  if (!account || account.chainId !== 10143 || !/^0x[0-9a-f]{40}$/i.test(account.address))
    throw new Error("Invalid native wallet");
  const { fundingAddress } = await native.getSwapDeposit();
  if (!/^0x[0-9a-f]{40}$/i.test(fundingAddress)) throw new Error("Invalid native funding account");
  return {
    kind: "mainnet",
    method: "Passkey",
    accountId: fundingAddress.toLowerCase(),
    address: fundingAddress,
    accountIndex: 1,
    chainId: 143,
    walletId: state.walletId,
  };
}
export function createStoredWalletAccess(
  getBridge: () => StoredWalletBridge | null,
): AccessService {
  let generation = 0;
  function bridge() {
    const value = getBridge();
    if (!value) throw new WalletUnavailableError();
    return value;
  }
  return {
    method: "Passkey",
    async localWallet() {
      const { status } = await bridge().getWalletState();
      if (status === "absent") return "absent";
      return status === "recoveryRequired" ? "unreadable" : "present";
    },
    async request() {
      const attempt = ++generation;
      const native = bridge();
      const active = () => {
        if (generation !== attempt) throw new Error("Cancelled");
      };
      let state = await native.getWalletState();
      active();
      if (state.status === "absent") {
        state = await native.createWallet();
        active();
      } else if (state.status === "ready") {
        state = await native.openWallet();
        active();
      }
      if (state.status === "backupRequired") {
        state = await native.backupWallet();
        active();
      }
      const result = await session(state, native);
      active();
      return result;
    },
    async restore() {
      const attempt = ++generation;
      const result = await bridge().restoreWallet();
      if (generation !== attempt) throw new Error("Cancelled");
      const restored = await session(result, bridge());
      if (generation !== attempt) throw new Error("Cancelled");
      return restored;
    },
    cancel() {
      generation++;
      getBridge()?.lock();
    },
  };
}
