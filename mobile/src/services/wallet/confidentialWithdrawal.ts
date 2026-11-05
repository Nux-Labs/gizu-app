import {
  parseConfidentialWithdrawal,
  type ConfidentialWithdrawal,
  type ConfidentialWithdrawalService,
} from "@/domain/wallet/confidentialWithdrawal";
import { getStoredConfidentialWithdrawalSigner } from "./nativeBridge";
type Request = { walletId: string; operationId: string; revision?: number };
export interface ConfidentialWithdrawalBridge {
  getConfidentialWithdrawal(walletId: string): Promise<unknown>;
  prepareConfidentialWithdrawal(request: {
    walletId: string;
    amountAtoms: string;
  }): Promise<unknown>;
  executeConfidentialWithdrawal(request: Request & { revision: number }): Promise<unknown>;
  resumeConfidentialWithdrawal(request: Request): Promise<unknown>;
  cancelConfidentialWithdrawal(request: Request): Promise<unknown>;
}
export function createConfidentialWithdrawalService(
  walletId: string,
  getBridge: () => ConfidentialWithdrawalBridge | null = getStoredConfidentialWithdrawalSigner,
): ConfidentialWithdrawalService {
  let occupied = false;
  function bridge() {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(walletId))
      throw new Error("Verified private wallet required.");
    const value = getBridge();
    if (!value) throw new Error("Confidential withdrawals require the updated native build.");
    return value;
  }
  async function perform(
    action: (native: ConfidentialWithdrawalBridge) => Promise<unknown>,
    previous?: ConfidentialWithdrawal,
  ) {
    if (occupied) throw new Error("A withdrawal action is already running.");
    if (previous) parseConfidentialWithdrawal(previous, walletId);
    occupied = true;
    try {
      const result = parseConfidentialWithdrawal(await action(bridge()), walletId);
      if (
        !result ||
        (previous &&
          (result.operationId !== previous.operationId ||
            result.amountAtoms !== previous.amountAtoms ||
            result.walletCount !== previous.walletCount ||
            result.weightsBps.join() !== previous.weightsBps.join()))
      )
        throw new Error("Saved native withdrawal changed. Check its progress before retrying.");
      return result;
    } finally {
      occupied = false;
    }
  }
  return {
    async available() {
      return getBridge() !== null;
    },
    async read() {
      return parseConfidentialWithdrawal(
        await bridge().getConfidentialWithdrawal(walletId),
        walletId,
      );
    },
    async prepare(amountAtoms) {
      if (!/^[1-9][0-9]{0,19}$/.test(amountAtoms) || BigInt(amountAtoms) > 18446744073709551615n)
        throw new Error("Invalid private withdrawal amount.");
      const result = await perform((native) =>
        native.prepareConfidentialWithdrawal({ walletId, amountAtoms }),
      );
      if (result.amountAtoms !== amountAtoms) throw new Error("Native withdrawal amount changed.");
      return result;
    },
    execute: (plan) =>
      perform(
        (native) =>
          native.executeConfidentialWithdrawal({
            walletId,
            operationId: plan.operationId,
            revision: plan.revision,
          }),
        plan,
      ),
    resume: (plan) =>
      perform(
        (native) =>
          native.resumeConfidentialWithdrawal({ walletId, operationId: plan.operationId }),
        plan,
      ),
    cancel: (plan) =>
      perform(
        (native) =>
          native.cancelConfidentialWithdrawal({ walletId, operationId: plan.operationId }),
        plan,
      ),
  };
}
