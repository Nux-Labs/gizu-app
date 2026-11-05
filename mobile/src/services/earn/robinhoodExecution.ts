import { investmentDestination } from "@/domain/earn/distribution";
import { assertNotAborted } from "./abort";
import type { EarnIntent } from "@/domain/earn/types";
import {
  parseRobinhoodPlan,
  robinhoodProposal,
  type EarnRobinhoodService,
} from "@/domain/earn/robinhoodExecution";
import { parseSponsoredOperations, type SponsoredOperation } from "@/domain/earn/sourceFunding";
import {
  getSignerCapabilities,
  getStoredEarnSponsoredSigner,
} from "@/services/wallet/nativeBridge";
export function createEarnRobinhoodService(
  baseUrl: string,
  bridgeFactory = getStoredEarnSponsoredSigner,
  now = Date.now,
): EarnRobinhoodService {
  let generation = 0,
    occupied = false;
  function bridge() {
    const b = bridgeFactory();
    if (!b) throw new Error("Robinhood execution requires the updated native signer.");
    return b;
  }
  function supported(intent: EarnIntent) {
    if (intent.profileId !== "robinhood-usdg" || intent.status !== "prepared")
      throw new Error("Robinhood intent requires native recovery reconciliation.");
  }
  async function action<T>(task: () => Promise<T>) {
    if (occupied) throw new Error("Another Robinhood action is running.");
    occupied = true;
    const attempt = generation;
    try {
      const value = await task();
      if (attempt !== generation)
        throw new Error("Earn review closed. Reconcile native saved progress before retrying.");
      return value;
    } finally {
      occupied = false;
    }
  }
  function operation(value: unknown, intent: EarnIntent) {
    const op = parseSponsoredOperations([value], intent)[0]!;
    if (op.kind === "sourceFunding")
      throw new Error("Source funding is a separate native operation.");
    return op;
  }
  function validate(intent: EarnIntent, op: SponsoredOperation) {
    supported(intent);
    operation(op, intent);
  }
  return {
    async available() {
      return (await getSignerCapabilities()).earnSponsoredExecution === true;
    },
    async plan(intent, kind, signal) {
      return action(async () => {
        supported(intent);
        if (!baseUrl) throw new Error("Robinhood planning is not configured.");
        assertNotAborted(signal);
        const operationId = `hood_${kind}_${now()}_${Math.random().toString(36).slice(2, 10)}`,
          revision = 1,
          controller = new AbortController(),
          abort = () => controller.abort();
        signal.addEventListener("abort", abort);
        const timeout = setTimeout(abort, 60000);
        try {
          const response = await fetch(
            baseUrl.replace(/\/$/, "") +
              `/v1/earn/robinhood/${kind === "hoodDeposit" ? "deposit" : kind === "hoodRedeemAll" ? "withdrawal" : "return"}-plan`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                owner: investmentDestination(intent).address,
                operationId,
                revision,
                ...(kind === "hoodTokenReturn"
                  ? {
                      confidentialAccount: intent.confidentialAddress,
                      ...((await getSignerCapabilities()).earnBalanceDeltaSettlement === true
                        ? { settlementMode: "balance-delta-v1" }
                        : {}),
                    }
                  : {}),
              }),
              signal: controller.signal,
            },
          );
          if (!response.ok)
            throw new Error(
              response.status === 404
                ? "Robinhood planning has not been deployed yet."
                : "Fresh USDG fees, shares and funding could not be verified. Refresh before authorizing.",
            );
          const value = await response.json();
          assertNotAborted(controller.signal);
          return parseRobinhoodPlan(value, intent, kind, operationId, revision, now());
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
        }
      });
    },
    async execute(intent, plan) {
      supported(intent);
      const request = robinhoodProposal(plan, intent, now());
      return action(async () => {
        const op = operation(await bridge().executeEarnSponsored(request), intent);
        if (
          op.operationId !== plan.operationId ||
          op.kind !== plan.kind ||
          op.amountAtoms !== plan.amountAtoms
        )
          throw new Error("Native Robinhood approval binding changed. Check saved progress.");
        return op;
      });
    },
    async list(intent) {
      supported(intent);
      return action(async () =>
        parseSponsoredOperations(
          await bridge().listEarnSponsoredOperations(intent.walletId),
          intent,
        ).filter((op) => op.kind !== "sourceFunding"),
      );
    },
    async resume(intent, op) {
      validate(intent, op);
      if (!op.canResume)
        throw new Error("Reconcile this saved operation before authorizing another step.");
      return action(async () =>
        operation(
          await bridge().resumeEarnSponsoredOperation(intent.walletId, op.operationId, op.revision),
          intent,
        ),
      );
    },
    async reconcileCredit(intent, op) {
      validate(intent, op);
      if (op.kind !== "hoodTokenReturn")
        throw new Error("Only a submitted USDG return has confidential credit.");
      return action(async () =>
        operation(
          await bridge().readEarnSponsoredSettlement(intent.walletId, op.operationId, op.revision),
          intent,
        ),
      );
    },
    async cancelUnsigned(intent, op) {
      validate(intent, op);
      if (op.userOperationHash || !(op.canCancelPreparation ?? op.status === "planned"))
        throw new Error("Signed progress must be reconciled before releasing its wallet.");
      return action(async () =>
        operation(
          await bridge().cancelEarnSponsoredOperation(intent.walletId, op.operationId, op.revision),
          intent,
        ),
      );
    },
    cancel() {
      generation++;
      if (occupied) bridgeFactory()?.lock();
    },
  };
}
export const earnRobinhoodService = createEarnRobinhoodService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
