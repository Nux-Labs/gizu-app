import { investmentDestination } from "@/domain/earn/distribution";
import { assertNotAborted } from "./abort";
import { getSignerCapabilities, getStoredEarnVaultSigner } from "@/services/wallet/nativeBridge";
import {
  parseVaultOperations,
  parseVaultPlan,
  vaultProposal,
  type EarnVaultExecutionService,
} from "@/domain/earn/vaultExecution";
import type { EarnIntent } from "@/domain/earn/types";
export function createEarnVaultExecutionService(
  baseUrl: string,
  bridgeFactory = getStoredEarnVaultSigner,
  now = Date.now,
): EarnVaultExecutionService {
  let generation = 0,
    occupied = false;
  const bridge = () => {
    const b = bridgeFactory();
    if (!b) throw new Error("Native vault execution is unavailable in this build.");
    return b;
  };
  async function action(
    intent: EarnIntent,
    task: (b: NonNullable<ReturnType<typeof bridgeFactory>>) => Promise<unknown>,
    array = false,
  ) {
    if (occupied) throw new Error("Another native earn operation is running.");
    occupied = true;
    const attempt = generation;
    try {
      const raw = await task(bridge());
      if (attempt !== generation)
        throw new Error("Earn operation closed. Reconcile saved progress before retrying.");
      return parseVaultOperations(array ? raw : [raw], intent);
    } finally {
      occupied = false;
    }
  }
  return {
    async available() {
      return (await getSignerCapabilities()).earnVaultExecution === true;
    },
    async plan(intent, kind, signal) {
      if (intent.status !== "prepared" || intent.profileId !== "ethereum-usdc")
        throw new Error("This intent needs native execution support or recovery reconciliation.");
      if (!baseUrl) throw new Error("Earn planning is not configured.");
      assertNotAborted(signal);
      const operationId = `earn_${kind}_${now()}_${Math.random().toString(36).slice(2, 10)}`,
        revision = 1;
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, 60000);
      try {
        const response = await fetch(
          baseUrl.replace(/\/$/, "") +
            `/v1/earn/ethereum/${kind === "vaultDeposit" ? "deposit" : "withdrawal"}-plan`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              owner: investmentDestination(intent).address,
              operationId,
              revision,
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Earn planning has not been deployed yet."
              : "Could not verify live fees and funding. Confirm the payout and refresh the plan.",
          );
        const result = await response.json();
        assertNotAborted(controller.signal);
        return parseVaultPlan(result, intent, kind, operationId, revision, now());
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    },
    async list(intent) {
      return action(intent, (b) => b.listEarnVaultOperations(intent.walletId), true);
    },
    async execute(intent, plan) {
      const proposal = vaultProposal(plan, intent, now());
      return (await action(intent, (b) => b.executeEarnVault(proposal)))[0]!;
    },
    async resume(intent, op) {
      parseVaultOperations([op], intent);
      return (
        await action(intent, (b) =>
          b.resumeEarnVaultOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async cancelUnsigned(intent, op) {
      parseVaultOperations([op], intent);
      if (op.steps.some((s) => s.transactionHash))
        throw new Error("A signed operation must be reconciled before releasing its wallet.");
      return (
        await action(intent, (b) =>
          b.cancelEarnVaultOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    cancel() {
      generation++;
      bridgeFactory()?.lock();
    },
  };
}
export const earnVaultExecutionService = createEarnVaultExecutionService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
