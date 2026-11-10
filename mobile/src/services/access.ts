export type AccessMethod = "Demo passkey" | "Passkey";
export type DemoSession = { kind: "demo"; method: AccessMethod; accountId?: string };
export type TestnetWalletSession = {
  kind: "testnet";
  method: "Passkey";
  accountId: string;
  address: string;
  accountIndex: 0;
  chainId: 10143;
  walletId?: string;
};
export type MainnetWalletSession = Omit<
  TestnetWalletSession,
  "kind" | "chainId" | "accountIndex"
> & {
  kind: "mainnet";
  chainId: 143;
  accountIndex: 1;
};
export type WalletSession = TestnetWalletSession | MainnetWalletSession;
export type AppSession = DemoSession | WalletSession;
export function isWalletSession(session: AppSession | null): session is WalletSession {
  return session?.kind === "mainnet" || session?.kind === "testnet";
}
// "present" can be unlocked with its passkey; "unreadable" can only be restored from backup.
export type LocalWalletStatus = "absent" | "present" | "unreadable";
export interface AccessService {
  method?: AccessMethod;
  cancel?(): void;
  localWallet?(): Promise<LocalWalletStatus>;
  restore?(): Promise<AppSession>;
  request(method: AccessMethod): Promise<AppSession>;
}
export class AccessRejectedError extends Error {}
// No device credentials, network calls or signing. Session lasts only in memory.
export const demoAccessService: AccessService = {
  async request(method) {
    return { kind: "demo", method };
  },
};
