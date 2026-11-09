import { investmentDestination } from "@/domain/earn/distribution";
import { assertNotAborted } from "./abort";
import {
  getSignerCapabilities,
  getStoredEarnLiquiditySigner,
} from "@/services/wallet/nativeBridge";
import {
  parseFusionQuote,
  parseEthereumReturnPlan,
  parseLiquidityOperations,
  type EarnLiquidityService,
} from "@/domain/earn/ethereumLiquidity";
import type { EarnIntent } from "@/domain/earn/types";
export function createEarnLiquidityService(
  baseUrl: string,
  bridgeFactory = getStoredEarnLiquiditySigner,
  now = Date.now,
): EarnLiquidityService {
  let generation = 0,
    occupied = false;
  const bridge = () => {
    const b = bridgeFactory();
    if (!b) throw new Error("Native Ethereum liquidity execution is unavailable.");
    return b;
  };
  async function action(
    intent: EarnIntent,
    task: (b: NonNullable<ReturnType<typeof bridgeFactory>>) => Promise<unknown>,
    array = false,
  ) {
    if (occupied) throw new Error("Another Earn operation is running.");
    occupied = true;
    const attempt = generation;
    try {
      const raw = await task(bridge());
      if (attempt !== generation)
        throw new Error("Operation closed. Reconcile saved native progress before retrying.");
      return parseLiquidityOperations(array ? raw : [raw], intent);
    } finally {
      occupied = false;
    }
  }
  return {
    async available() {
      return (await getSignerCapabilities()).earnEthereumLiquidityExecution === true;
    },
    async bootstrap(intent, plan) {
      if (!plan.fusionRequired || !plan.fusionFunding || plan.expiresAtMs <= now())
        throw new Error("Refresh the investment fee review first.");
      if (occupied) throw new Error("Another Earn operation is running.");
      const operationId = `earn_fusion_${now()}_${Math.random().toString(36).slice(2, 10)}`,
        revision = 1,
        attempt = generation;
      const raw = await bridge().prepareEarnFusionQuote({
        walletId: intent.walletId,
        operationId,
        revision,
        inputAtoms: plan.bootstrapUsdc,
        ...plan.fusionFunding,
        fundingMode: "permit",
      });
      if (attempt !== generation) throw new Error("ETH review cancelled.");
      return parseFusionQuote(
        raw,
        intent,
        operationId,
        revision,
        plan.bootstrapUsdc,
        plan.fusionFunding.minimumEthWei,
        plan.fusionFunding.maximumResolverOverheadWei,
        now(),
      );
    },
    async returnPlan(intent, asset, signal) {
      if (!baseUrl) throw new Error("Earn return planning is not configured.");
      assertNotAborted(signal);
      const operationId = `earn_return_${now()}_${Math.random().toString(36).slice(2, 10)}`,
        revision = 1;
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, 60000);
      try {
        const response = await fetch(baseUrl.replace(/\/$/, "") + "/v1/earn/ethereum/return-plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner: investmentDestination(intent).address,
            confidentialAccount: intent.confidentialAddress,
            operationId,
            revision,
            returnAsset: asset,
            ...((await getSignerCapabilities()).earnBalanceDeltaSettlement === true
              ? { settlementMode: "balance-delta-v1" }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Earn returns have not been deployed yet."
              : "A fresh return quote and gas budget are unavailable. Assets remain in your investment wallet.",
          );
        const raw = await response.json();
        assertNotAborted(controller.signal);
        return parseEthereumReturnPlan(raw, intent, operationId, revision, now());
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    },
    async execute(intent, plan) {
      if (plan.expiresAtMs <= now()) throw new Error("Liquidity review expired.");
      return (
        await action(intent, (b) =>
          b.executeEarnEthereumLiquidity({ walletId: intent.walletId, proposal: plan.proposal }),
        )
      )[0]!;
    },
    async list(intent) {
      return action(intent, (b) => b.listEarnEthereumLiquidityOperations(intent.walletId), true);
    },
    async resume(intent, op) {
      parseLiquidityOperations([op], intent);
      return (
        await action(intent, (b) =>
          b.resumeEarnEthereumLiquidityOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async reconcileCredit(intent, op) {
      parseLiquidityOperations([op], intent);
      if (!["awaitingSettlement", "credited", "minimumReceived"].includes(op.status))
        throw new Error("Confirm the origin return before authenticating settlement.");
      return (
        await action(intent, (b) =>
          b.readEarnEthereumLiquiditySettlement(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async cancelUnsigned(intent, op) {
      parseLiquidityOperations([op], intent);
      if (op.status !== "planned") throw new Error("Saved signed authority must be reconciled.");
      return (
        await action(intent, (b) =>
          b.cancelEarnEthereumLiquidityOperation(intent.walletId, op.operationId, op.revision),
        )
      )[0]!;
    },
    async cancelPending(intent, op) {
      parseLiquidityOperations([op], intent);
      if (op.canCancelPending !== true || !op.blocked || !op.transactionHash)
        throw new Error("Native journal cancellation is unavailable for this operation.");
      return (
        await action(intent, (b) =>
          b.cancelPendingEarnEthereumLiquidityOperation(
            intent.walletId,
            op.operationId,
            op.revision,
          ),
        )
      )[0]!;
    },
    cancel() {
      generation++;
      if (occupied) bridgeFactory()?.lock();
    },
  };
}
export const earnLiquidityService = createEarnLiquidityService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
