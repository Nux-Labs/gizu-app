export interface OperationCoordinationStore {
  /** Atomic bind or exclusive first-use claim. Must use the database clock. */
  bind(
    opaqueKey: string,
    commitment: string,
    expiresAtMs: number,
    exclusive: boolean,
  ): Promise<boolean>;
  purgeExpired?(): Promise<void>;
}
