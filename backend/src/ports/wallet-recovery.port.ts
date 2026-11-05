export interface RecoverySnapshot {
  version: 1;
  revision: number;
  ciphertext: string;
}
export type RecoveryWrite =
  | { status: "missing" | "conflict" | "quota" }
  | { status: "ok"; snapshot: RecoverySnapshot };
/** Credentials reach persistence only as domain-separated digests. */
export interface WalletRecoveryStore {
  remove(id: string, authDigest: string): Promise<void>;
  read(id: string, authDigest: string): Promise<RecoverySnapshot | null>;
  write(
    id: string,
    authDigest: string,
    expectedRevision: number,
    ciphertext: string,
  ): Promise<RecoveryWrite>;
}
