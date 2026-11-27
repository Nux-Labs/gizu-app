import { fundingCapabilityService } from "@/services/wallet/fundingCapabilities";
import {
  getSignerCapabilities,
  getStoredEarnPayoutSigner,
  getStoredEarnFundingParentSigner,
} from "@/services/wallet/nativeBridge";
import {
  parsePayoutOperations,
  parseFundingParents,
  payoutParentRequest,
  type EarnFundingParent,
  payoutRequest,
  type EarnPayoutService,
} from "@/domain/earn/privatePayout";
import type { EarnIntent } from "@/domain/earn/types";
export function createEarnPayoutService(
  bridgeFactory = getStoredEarnPayoutSigner,
  parentFactory = getStoredEarnFundingParentSigner,
): EarnPayoutService {
  let occupied = false,
    generation = 0;
  const bridge = () => {
    const b = bridgeFactory();
    if (!b) throw new Error("Native confidential payouts are unavailable in this build.");
    return b;
  };
  async function action(
    intent: EarnIntent,
    task: (b: NonNullable<ReturnType<typeof bridgeFactory>>) => Promise<unknown>,
    array = false,
  ) {
    if (occupied) throw new Error("Another confidential payout is running.");
    occupied = true;
    const attempt = generation;
    try {
      const raw = await task(bridge());
      if (attempt !== generation)
        throw new Error("Payout closed. Check saved progress before retrying.");
      return parsePayoutOperations(array ? raw : [raw], intent);
    } finally {
      occupied = false;
    }
  }
  async function parentAction(
    intent: EarnIntent,
    task: (
      bridge: NonNullable<ReturnType<typeof getStoredEarnFundingParentSigner>>,
    ) => Promise<unknown>,
    array = false,
  ) {
    if (occupied) throw new Error("Another confidential funding operation is running.");
    const native = parentFactory?.();
    if (!native) throw new Error("Native combined funding is unavailable in this build.");
    occupied = true;
    const attempt = generation;
    try {
      const result = await task(native);
      if (attempt !== generation)
        throw new Error("Funding closed. Resume the saved parent before retrying.");
      return parseFundingParents(array ? result : [result], intent);
    } finally {
      occupied = false;
    }
  }
  function parentReference(intent: EarnIntent, parent: EarnFundingParent) {
    const saved = parseFundingParents([parent], intent)[0]!;
    return {
      version: 2 as const,
      walletId: intent.walletId,
      parentOperationId: saved.operationId,
      revision: saved.revision,
    };
  }
  return {
    async available() {
      return (await getSignerCapabilities()).earnPrivatePayoutExecution === true;
    },
    async fundingRecoveryAvailable() {
      return (
        (await getSignerCapabilities()).earnPrivateFundingVersion === 2 && parentFactory?.() != null
      );
    },
    async fundingAvailable() {
      return (
        (await getSignerCapabilities()).earnPrivateFundingVersion === 2 &&
        parentFactory?.() != null &&
        (await fundingCapabilityService.ethereumPrivateFundingAvailable())
      );
    },
    async listFunding(intent) {
      return parentAction(intent, (native) => native.listEarnFundingParents(intent.walletId), true);
    },
    async planFunding(intent, budgetAtoms) {
      if (!/^[1-9][0-9]{0,77}$/.test(budgetAtoms))
        throw new Error("Choose a positive USDC funding budget.");
      return (
        await parentAction(intent, (native) =>
          native.createEarnFundingParent({
            version: 2,
            walletId: intent.walletId,
            cycleIndex: intent.cycleIndex ?? 0,
            budgetAtoms,
          }),
        )
      )[0]!;
    },
    async executeFunding(intent, parent) {
      return (
        await parentAction(intent, (native) =>
          native.executeEarnFundingParent(parentReference(intent, parent)),
        )
      )[0]!;
    },
    async resumeFunding(intent, parent) {
      return (
        await parentAction(intent, (native) =>
          native.resumeEarnFundingParent(parentReference(intent, parent)),
        )
      )[0]!;
    },
    async reconcileFunding(intent, parent) {
      return (
        await parentAction(intent, (native) =>
          native.reconcileEarnFundingParent(parentReference(intent, parent)),
        )
      )[0]!;
    },
    async executeFromParent(intent, parent, leg) {
      const request = payoutParentRequest(intent, parent, leg);
      return (await action(intent, (native) => native.executeEarnPrivatePayout(request)))[0]!;
    },
    async list(intent) {
      return action(intent, (b) => b.listEarnPrivatePayoutOperations(intent.walletId), true);
    },
    async execute(intent, source, leg) {
      const request = payoutRequest(intent, source, leg);
      return (await action(intent, (b) => b.executeEarnPrivatePayout(request)))[0]!;
    },
    async resume(intent, op) {
      parsePayoutOperations([op], intent);
      return (
        await action(intent, (b) =>
          b.resumeEarnPrivatePayoutOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async reconcile(intent, op) {
      parsePayoutOperations([op], intent);
      return (
        await action(intent, (b) =>
          b.readEarnPrivatePayoutSettlement(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async cancelUnsigned(intent, op) {
      parsePayoutOperations([op], intent);
      if (op.status !== "planned") throw new Error("Signed payout authority must be reconciled.");
      return (
        await action(intent, (b) =>
          b.cancelEarnPrivatePayoutOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    cancel() {
      generation++;
      if (occupied) {
        bridgeFactory()?.lock();
        parentFactory?.()?.lock();
      }
    },
  };
}
export const earnPayoutService = createEarnPayoutService();
