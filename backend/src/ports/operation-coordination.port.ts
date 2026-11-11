export interface OperationCoordinationStore {
  /** Atomic bind or exclusive first-use claim. Must use the database clock. */
  bind(
    opaqueKey: string,
    commitment: string,
    expiresAtMs: number,
    exclusive: boolean,
  ): Promise<boolean>;
  /** All bindings succeed or none do. Existing exact compatible commitments are preserved. */
  bindMany?(
    bindings: Array<{
      opaqueKey: string;
      commitments: string[];
      expiresAtMs: number;
    }>,
  ): Promise<boolean>;
  purgeExpired?(): Promise<void>;
}
