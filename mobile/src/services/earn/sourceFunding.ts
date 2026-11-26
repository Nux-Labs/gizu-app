import { assertNotAborted } from "./abort";
import type { EarnIntent } from "@/domain/earn/types";
import type { FundingSourceKey } from "@/domain/wallet/storedSigner";
import { fundingSourceIdentity } from "@/domain/wallet/fundingNetworks";
import { earnAtoms } from "@/domain/earn/vaultExecution";
import {
  parsePublicFundingPlan,
  parseSourceQuote,
  parseSourcePreview,
  SourceFundingBlocked,
  parseSourceFeePlan,
  sourceFundingProposal,
  parseSponsoredOperations,
  type EarnSourceFundingService,
  type SourceFundingPlan,
} from "@/domain/earn/sourceFunding";
import {
  getSignerCapabilities,
  getStoredEarnSponsoredSigner,
} from "@/services/wallet/nativeBridge";
export function createEarnSourceFundingService(
  baseUrl: string,
  bridgeFactory = getStoredEarnSponsoredSigner,
  now = Date.now,
): EarnSourceFundingService {
  let generation = 0,
    occupied = false;

  const bridge = () => {
    const result = bridgeFactory();
    if (!result) throw new Error("Source USDC funding requires the updated native signer.");
    return result;
  };
  async function action<T>(task: () => Promise<T>) {
    if (occupied) throw new Error("Another source funding action is running.");
    occupied = true;
    const attempt = generation;
    try {
      const result = await task();
      if (attempt !== generation)
        throw new Error("Funding closed. Reconcile saved progress before retrying.");
      return result;
    } finally {
      occupied = false;
    }
  }
  async function fees(
    intent: EarnIntent,
    recipient: string,
    amount: string,
    budget: string,
    signal: AbortSignal,
    source?: FundingSourceKey,
  ) {
    if (!baseUrl) throw new Error("USDC funding service is not configured.");
    assertNotAborted(signal);
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    const timeout = setTimeout(abort, 60000);
    try {
      const chain = source?.sourceChainId ?? 143;
      const response = await fetch(
        baseUrl.replace(/\/$/, "") +
          (chain === 143 ? "/v1/earn/monad/funding-plan" : `/v1/funding/${chain}/plan`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: intent.sourceAddress, recipient, amount, budget }),
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "USDC funding service has not been deployed yet."
            : "A fresh USDC sponsorship quote could not be verified.",
        );
      const raw = await response.json();
      assertNotAborted(controller.signal);
      return parseSourceFeePlan(raw, intent, recipient, amount, budget, now(), source);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
  function fundingRequest(intent: EarnIntent, plan: SourceFundingPlan) {
    const selectedIntent = plan.sourceAddress
      ? { ...intent, sourceAddress: plan.sourceAddress }
      : intent;
    const request = sourceFundingProposal(
      selectedIntent,
      plan.quote,
      plan.fees,
      plan.budget,
      now(),
      plan.sourceAccountIndex,
      plan.source,
    );
    if (plan.fundingBatchId) {
      request.proposal.fundingBatchId = plan.fundingBatchId;
      request.proposal.fundingBatchSize = plan.fundingBatchSize;
    }
    return request;
  }
  const service: EarnSourceFundingService = {
    async available() {
      return (await getSignerCapabilities()).earnSponsoredExecution === true;
    },
    async plan(intent, budget, sourceBalance, signal, selectedSourceIndex, source) {
      return action(async () => {
        if (source) {
          fundingSourceIdentity(source);
          if (
            source.accountIndex !== selectedSourceIndex ||
            source.owner.toLowerCase() !== intent.sourceAddress.toLowerCase()
          )
            throw new Error("Funding source changed");
          if (source.sourceChainId !== 143) {
            const capabilities = await getSignerCapabilities();
            if (
              capabilities.fundingContractVersion !== 2 ||
              !capabilities.fundingChainIds?.includes(source.sourceChainId)
            )
              throw new Error("This funding network requires the updated native signer.");
          }
        }
        const total = BigInt(earnAtoms(budget));
        if (
          intent.status !== "prepared" ||
          total <= 10000n ||
          total > BigInt(earnAtoms(sourceBalance))
        )
          throw new Error("Choose a budget within your funded source USDC balance, including gas.");
        const probe = await fees(intent, intent.confidentialAddress, "1", budget, signal, source);
        let amount = total - BigInt(probe.feeCap) - 10000n;
        const operationId = `source_${now()}_${Math.random().toString(36).slice(2, 10)}`;
        for (let revision = 1; revision <= 4; revision++) {
          if (amount < 10n)
            throw new Error("Source budget does not cover gas and the retained 0.01 USDC.");
          assertNotAborted(signal);
          let q: unknown;
          try {
            const signer = bridge();
            if (source && source.sourceChainId !== 143 && !signer.prepareEarnSourceQuoteForSource)
              throw new Error("This funding network requires the updated native source signer.");
            q = await (source && signer.prepareEarnSourceQuoteForSource
              ? signer.prepareEarnSourceQuoteForSource(
                  intent.walletId,
                  source,
                  amount.toString(),
                  operationId,
                  revision,
                )
              : selectedSourceIndex !== undefined && signer.prepareEarnSourceQuoteForAccount
                ? signer.prepareEarnSourceQuoteForAccount(
                    intent.walletId,
                    selectedSourceIndex,
                    amount.toString(),
                    operationId,
                    revision,
                  )
                : signer.prepareEarnSourceQuote(
                    intent.walletId,
                    amount.toString(),
                    operationId,
                    revision,
                  ));
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (
              ![
                "EARN_AURORA_FEE_UNQUALIFIED",
                "EARN_SETTLEMENT_UNQUALIFIED",
                "EARN_RECOVERY_UNAVAILABLE",
              ].includes(code ?? "")
            )
              throw error;
            assertNotAborted(signal);
            const previewController = new AbortController(),
              abortPreview = () => previewController.abort();
            signal.addEventListener("abort", abortPreview);
            const timer = setTimeout(abortPreview, 15000);
            try {
              const response = await fetch(
                baseUrl.replace(/\/$/, "") + "/v1/earn/native/source-preview",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    operationId,
                    revision,
                    profileChainId: intent.profileId === "ethereum-usdc" ? 1 : 4663,
                    ...(source && source.sourceChainId !== 143
                      ? { sourceChainId: source.sourceChainId }
                      : {}),
                    sourceOwner: intent.sourceAddress,
                    confidentialAccount: intent.confidentialAddress,
                    amountAtoms: amount.toString(),
                  }),
                  signal: previewController.signal,
                },
              );
              if (!response.ok)
                throw new Error("Unsigned funding preview is unavailable. No funds moved.");
              const preview = parseSourcePreview(
                await response.json(),
                intent,
                amount.toString(),
                budget,
                probe.feeCap,
                now(),
              );
              assertNotAborted(signal);
              assertNotAborted(previewController.signal);
              throw new SourceFundingBlocked(preview);
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", abortPreview);
            }
          }
          assertNotAborted(signal);
          const quote = parseSourceQuote(
              q,
              intent,
              operationId,
              revision,
              amount.toString(),
              now(),
              source,
            ),
            plan = await fees(intent, quote.recipient, amount.toString(), budget, signal, source);
          if (amount + BigInt(plan.feeCap) + 10000n <= total)
            return {
              ...(selectedSourceIndex !== undefined
                ? { sourceAccountIndex: selectedSourceIndex, sourceAddress: intent.sourceAddress }
                : {}),
              ...(source ? { source } : {}),
              quote,
              fees: plan,
              budget,
              expiresAtMs: Math.min(plan.expiresAtMs, quote.expiresAt * 1000),
            };
          amount = total - BigInt(plan.feeCap) - 10000n;
        }
        throw new Error("Source USDC fees did not stabilize. No operation was signed.");
      });
    },
    async executeMany(intent, plans) {
      if (
        plans.length === 1 &&
        !plans[0]!.fundingBatchId &&
        plans[0]!.sourceAccountIndex === undefined
      )
        return [await service.execute(intent, plans[0]!)];
      const batchId = plans[0]?.fundingBatchId;
      if (
        !batchId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(batchId) ||
        plans.length > 256 ||
        plans.some(
          (p) =>
            p.fundingBatchId !== batchId ||
            p.fundingBatchSize !== plans.length ||
            p.sourceAccountIndex === undefined ||
            !p.sourceAddress,
        ) ||
        new Set(plans.map((p) => p.quote.operationId)).size !== plans.length ||
        new Set(
          plans.map(
            (p) =>
              `${p.quote.chainId}:${p.quote.token.toLowerCase()}:${p.sourceAddress!.toLowerCase()}`,
          ),
        ).size !== plans.length
      )
        throw new Error("Saved native funding batch binding changed. Review saved progress.");
      return action(async () => {
        const native = bridge();
        if (!native.executeEarnFundingBatch)
          throw new Error("USDC funding requires the updated native batch signer.");
        const rows = parseSponsoredOperations(
          await native.executeEarnFundingBatch(intent.walletId, batchId),
          intent,
        );
        if (
          !rows.length ||
          rows.length > plans.length ||
          rows.some((row) => {
            const plan = plans.find((p) => p.quote.operationId === row.operationId);
            return (
              !plan ||
              row.kind !== "sourceFunding" ||
              row.fundingBatchId !== batchId ||
              row.fundingBatchSize !== plans.length ||
              row.sourceAccountIndex !== plan.sourceAccountIndex ||
              row.chainId !== plan.quote.chainId ||
              row.from.toLowerCase() !== plan.sourceAddress!.toLowerCase() ||
              BigInt(row.amountAtoms) > BigInt(plan.budget) - 10000n
            );
          })
        )
          throw new Error("Native funding batch result changed. Check saved progress.");
        return rows;
      });
    },
    async resumeBatch(intent, batchId) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) throw new Error("Invalid saved funding batch.");
      return action(async () => {
        const native = bridge();
        if (!native.executeEarnFundingBatch)
          throw new Error("USDC funding requires the updated native batch signer.");
        const rows = parseSponsoredOperations(
          await native.executeEarnFundingBatch(intent.walletId, batchId),
          intent,
        );
        if (
          !rows.length ||
          rows.some((row) => row.kind !== "sourceFunding" || row.fundingBatchId !== batchId)
        )
          throw new Error("Native funding batch recovery changed. Check saved progress.");
        return rows;
      });
    },
    async execute(intent, plan) {
      const selectedIntent = plan.sourceAddress
        ? { ...intent, sourceAddress: plan.sourceAddress }
        : intent;
      const proposal = fundingRequest(intent, plan);
      return action(async () => {
        const operation = parseSponsoredOperations(
          [await bridge().executeEarnSponsored(proposal)],
          intent,
        )[0]!;
        if (
          operation.from.toLowerCase() !== selectedIntent.sourceAddress.toLowerCase() ||
          operation.chainId !== plan.quote.chainId ||
          (plan.sourceAccountIndex !== undefined &&
            operation.sourceAccountIndex !== plan.sourceAccountIndex) ||
          (plan.fundingBatchId &&
            (operation.fundingBatchId !== plan.fundingBatchId ||
              operation.fundingBatchSize !== plan.fundingBatchSize))
        )
          throw new Error("Native funding submission binding changed. Check saved progress.");
        return operation;
      });
    },
    async list(intent) {
      return action(async () =>
        parseSponsoredOperations(
          await bridge().listEarnSponsoredOperations(intent.walletId),
          intent,
        ),
      );
    },
    async resume(intent, op) {
      parseSponsoredOperations([op], intent);
      return action(
        async () =>
          parseSponsoredOperations(
            [
              await bridge().resumeEarnSponsoredOperation(
                intent.walletId,
                op.operationId,
                op.revision,
              ),
            ],
            intent,
          )[0]!,
      );
    },
    async reconcileCredit(intent, op) {
      parseSponsoredOperations([op], intent);
      if (op.kind !== "sourceFunding" && op.kind !== "hoodTokenReturn")
        throw new Error("This operation is not a confidential credit route.");
      return action(
        async () =>
          parseSponsoredOperations(
            [
              await bridge().readEarnSponsoredSettlement(
                intent.walletId,
                op.operationId,
                op.revision,
              ),
            ],
            intent,
          )[0]!,
      );
    },
    async cancelUnsigned(intent, op) {
      parseSponsoredOperations([op], intent);
      if (op.userOperationHash || !(op.canCancelPreparation ?? op.status === "planned"))
        throw new Error("A saved signature must be reconciled before releasing its wallet.");
      return action(
        async () =>
          parseSponsoredOperations(
            [
              await bridge().cancelEarnSponsoredOperation(
                intent.walletId,
                op.operationId,
                op.revision,
              ),
            ],
            intent,
          )[0]!,
      );
    },
    cancel() {
      generation++;
      if (occupied) bridgeFactory()?.lock();
    },
  };
  service.planMany = async (intent, budget, sourceBalance, signal) => {
    const attempt = generation;
    const native = bridge();
    if (!native.planPublicFunding)
      return [await service.plan(intent, budget, sourceBalance, signal)];
    if (!native.prepareEarnSourceQuoteForAccount && !native.prepareEarnSourceQuoteForSource)
      throw new Error("Multi-account funding requires the updated native signer.");
    const selection = parsePublicFundingPlan(
      await action(() => native.planPublicFunding!(intent.walletId, budget)),
      budget,
    );
    const plans = [];
    for (const leg of selection.legs) {
      if (attempt !== generation) throw new Error("Funding review cancelled.");
      assertNotAborted(signal);
      const reviewed = await service.plan(
        { ...intent, sourceAddress: leg.address },
        leg.budgetAtoms,
        leg.budgetAtoms,
        signal,
        leg.sourceIndex,
        leg.sourceChainId !== undefined
          ? {
              sourceChainId: leg.sourceChainId,
              token: leg.token!,
              accountIndex: leg.sourceIndex,
              owner: leg.address,
            }
          : undefined,
      );
      plans.push({
        ...reviewed,
        ...(selection.fundingBatchId
          ? { fundingBatchId: selection.fundingBatchId, fundingBatchSize: selection.legs.length }
          : {}),
      });
    }
    if (attempt !== generation) throw new Error("Funding review cancelled.");
    if (native.registerEarnFundingPlans) {
      const requests = plans.map((plan) => fundingRequest(intent, plan));
      const rows = await action(async () =>
        parseSponsoredOperations(
          await native.registerEarnFundingPlans!(intent.walletId, requests),
          intent,
        ),
      );
      if (
        rows.length !== requests.length ||
        requests.some(
          (request) =>
            !rows.some(
              (row) =>
                row.operationId === request.proposal.operationId &&
                row.from.toLowerCase() === request.proposal.expectedFrom.toLowerCase() &&
                row.sourceAccountIndex === request.proposal.sourceAccountIndex &&
                row.chainId === request.proposal.chainId &&
                row.fundingBatchId === request.proposal.fundingBatchId &&
                row.fundingBatchSize === request.proposal.fundingBatchSize &&
                row.status === "planned" &&
                !row.userOperationHash &&
                !row.transactionHash,
            ),
        )
      )
        throw new Error("Native unsigned funding registration changed. Check saved plans.");
    } else if (plans.length > 1)
      throw new Error("Recoverable funding batches require the updated native signer.");
    if (attempt !== generation) throw new Error("Funding review cancelled.");
    return plans;
  };
  return service;
}
export const earnSourceFundingService = createEarnSourceFundingService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
