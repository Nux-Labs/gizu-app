/** Permanent, keyed metadata only. Never expire these observations or their sequence. */
export type MinimumReturnReceipt = {
  accountKey: string;
  routeKey: string;
  commitment: string;
  sequence: string;
  minimumAtoms: string;
  observedAtMs: number;
};
export interface MinimumReturnStore {
  sequence(accountKey: string): Promise<string>;
  receipt(routeKey: string): Promise<MinimumReturnReceipt | undefined>;
  /** Atomically return an identical receipt, or insert and advance the expected
   * account sequence once. Changed bindings or sequence return undefined. */
  finish(
    receipt: MinimumReturnReceipt,
  ): Promise<MinimumReturnReceipt | undefined>;
}
