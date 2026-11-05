import { useCallback, useEffect, useRef, useState } from "react";
import type { EarnIntent } from "@/domain/earn/types";
import type { SourceFundingPlan, SponsoredOperation } from "@/domain/earn/sourceFunding";
import type { PayoutOperation } from "@/domain/earn/privatePayout";
import type { VaultOperation, VaultPlan } from "@/domain/earn/vaultExecution";
import type { LiquidityOperation, LiquidityPlan } from "@/domain/earn/ethereumLiquidity";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { useEarn } from "./EarnProvider";
import { depositBudgetAtoms } from "./useDepositJourney";
import { payoutLegs } from "@/domain/earn/distribution";
import { formatUsdc } from "@/domain/wallet/amounts";
/** Ethereum keeps its existing per-stage approvals, payload validation and durable engines. */
export function useLegacyEthereumDeposit(intent: EarnIntent) {
  const { sourceFunding: source, payout, liquidity, vaultExecution: vault } = useEarn(),
    wallet = useFundingWallet();
  const [amount, setAmount] = useState(
      intent.distributionBudgetAtoms ? formatUsdc(intent.distributionBudgetAtoms) : "",
    ),
    [fundings, setFundings] = useState<SponsoredOperation[]>([]),
    [payouts, setPayouts] = useState<PayoutOperation[]>([]),
    [fills, setFills] = useState<LiquidityOperation[]>([]),
    [positions, setPositions] = useState<VaultOperation[]>([]),
    [review, setReview] = useState<
      | { kind: "funding"; plans: SourceFundingPlan[] }
      | { kind: "liquidity"; plan: LiquidityPlan }
      | { kind: "vault"; plan: VaultPlan }
      | null
    >(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [available, setAvailable] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    occupied = useRef(false),
    abort = useRef<AbortController | null>(null);
  const load = useCallback(
    async (attempt: number) => {
      const caps = await Promise.all([
        source.available(),
        payout.available(),
        liquidity.available(),
        vault.available(),
      ]);
      if (attempt !== generation.current) return;
      setAvailable(caps.every(Boolean));
      if (!caps.every(Boolean)) return;
      const [s, p, l, v] = await Promise.all([
        source.list(intent),
        payout.list(intent),
        liquidity.list(intent),
        vault.list(intent),
      ]);
      if (attempt === generation.current) {
        setFundings(s.filter((r) => r.kind === "sourceFunding"));
        setPayouts(p);
        setFills(l);
        setPositions(v);
      }
    },
    [source, payout, liquidity, vault, intent],
  );
  useEffect(() => {
    const attempt = ++generation.current;
    void load(attempt)
      .catch((error) => {
        if (attempt === generation.current)
          setMessage(error instanceof Error ? error.message : "Saved deposit unavailable.");
      })
      .finally(() => {
        if (attempt === generation.current) setLoading(false);
      });
    return () => {
      generation.current = attempt + 1;
      abort.current?.abort();
      source.cancel();
      payout.cancel();
      liquidity.cancel();
      vault.cancel();
    };
  }, [intent, source, payout, liquidity, vault, load]);
  useEffect(() => {
    if (!review) return;
    const expiry =
      review.kind === "funding"
        ? Math.min(...review.plans.map((p) => p.expiresAtMs))
        : review.plan.expiresAtMs;
    const timer = setTimeout(
      () => {
        setReview(null);
        setMessage("Review expired. Refresh the remaining step.");
      },
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);
  const invested = positions.some(
    (p) => p.status === "invested" || p.status === "residualShares" || p.status === "withdrawn",
  );
  const active = fundings.filter((s) => s.status !== "cancelled" && s.status !== "reverted");
  const allCredit =
    active.length > 0 &&
    active.every(
      (s) =>
        s.status === "credited" &&
        !s.blocked &&
        (!s.fundingBatchId ||
          active.filter((r) => r.fundingBatchId === s.fundingBatchId).length ===
            s.fundingBatchSize),
    );
  const nextPayout = allCredit
    ? active
        .flatMap((s) =>
          payoutLegs(intent).map((leg) => ({
            source: s,
            leg,
            existing: payouts.find((p) => p.sourceOperationId === s.operationId && p.leg === leg),
          })),
        )
        .find((p) => p.existing?.status !== "paid")
    : undefined;
  const paid = allCredit && !nextPayout;
  const stage: "funding" | "payouts" | "liquidity" | "vault" = !allCredit
    ? "funding"
    : !paid
      ? "payouts"
      : review?.kind === "liquidity" ||
          fills.some(
            (l) =>
              l.kind === "fusionEthOrder" &&
              !["fusionFilled", "cancelled", "reverted"].includes(l.status),
          )
        ? "liquidity"
        : "vault";
  async function perform(task: (signal: AbortSignal) => Promise<void>) {
    if (occupied.current) return;
    occupied.current = true;
    setBusy(true);
    setMessage("");
    const attempt = generation.current,
      controller = new AbortController();
    abort.current = controller;
    try {
      await task(controller.signal);
      if (attempt === generation.current) await load(attempt);
    } catch (error) {
      if (attempt === generation.current)
        setMessage(
          error instanceof Error ? error.message : "Deposit stopped. Check saved activity.",
        );
    } finally {
      occupied.current = false;
      if (attempt === generation.current) setBusy(false);
    }
  }
  let label = "Review USDC funding";
  if (review)
    label =
      review.kind === "funding"
        ? "Authorize USDC funding"
        : review.kind === "liquidity"
          ? "Authorize ETH funding"
          : "Authorize vault deposit";
  else if (stage === "funding" && active.length) label = "Check funding progress";
  else if (stage === "payouts")
    label = nextPayout?.existing
      ? "Check payout progress"
      : intent.distribution
        ? `Review and authorize wallet ${Number(nextPayout?.leg.split(":")[1] ?? 0) + 1} payout`
        : `Review and authorize ${nextPayout?.leg === "hold" ? "10% hold" : "90% investment"} payout`;
  else if (stage === "liquidity") label = "Check ETH funding progress";
  else if (stage === "vault")
    label = positions.some((p) => p.blocked) ? "Review saved vault step" : "Review vault deposit";
  const primaryAction = () =>
    perform(async (signal) => {
      if (intent.profileId !== "ethereum-usdc" || intent.status !== "prepared")
        throw new Error("Saved native Ethereum identity required.");
      if (review) {
        const selected = review;
        setReview(null);
        if (selected.kind === "funding") {
          if (source.executeMany) await source.executeMany(intent, selected.plans);
          else {
            if (selected.plans.length !== 1) throw new Error("Multi-source signing unavailable.");
            await source.execute(intent, selected.plans[0]!);
          }
        } else if (selected.kind === "liquidity") await liquidity.execute(intent, selected.plan);
        else await vault.execute(intent, selected.plan);
        return;
      }
      if (stage === "funding") {
        if (active.length) {
          for (const row of active.filter((r) => r.status !== "credited")) {
            if (
              row.blocked &&
              ["sourceFunded", "awaitingSettlement", "pending", "unknown"].includes(row.status)
            )
              await source.reconcileCredit(intent, row);
            else if (row.canResume) await source.resume(intent, row);
          }
          return;
        }
        const budget = depositBudgetAtoms(amount);
        if (!budget || wallet.loading || wallet.error || !wallet.balance)
          throw new Error("Choose an amount within your available USDC.");
        const plans = source.planMany
          ? await source.planMany(intent, budget, depositBudgetAtoms(wallet.balance)!, signal)
          : [await source.plan(intent, budget, depositBudgetAtoms(wallet.balance)!, signal)];
        if (!signal.aborted) setReview({ kind: "funding", plans });
        return;
      }
      if (stage === "payouts" && nextPayout) {
        if (nextPayout.existing) {
          if (nextPayout.existing.canResume || nextPayout.existing.canRefreshUnsigned)
            await payout.resume(intent, nextPayout.existing);
          else await payout.reconcile(intent, nextPayout.existing);
        } else await payout.execute(intent, nextPayout.source, nextPayout.leg);
        return;
      }
      if (stage === "liquidity") {
        const row = fills.find(
          (l) =>
            l.kind === "fusionEthOrder" &&
            !["fusionFilled", "cancelled", "reverted"].includes(l.status),
        );
        if (row) await liquidity.resume(intent, row);
        return;
      }
      const saved = positions.find((p) => p.canResume);
      if (saved) {
        await vault.resume(intent, saved);
        return;
      }
      const plan = await vault.plan(intent, "vaultDeposit", signal);
      if (signal.aborted) return;
      if (plan.fusionRequired) {
        const fresh = await liquidity.bootstrap(intent, plan);
        if (!signal.aborted) setReview({ kind: "liquidity", plan: fresh });
      } else setReview({ kind: "vault", plan });
    });
  return {
    amount,
    setAmount,
    phase: invested ? "invested" : loading ? "loading" : review ? "review" : "ready",
    activeStage: stage,
    busy,
    loading,
    available,
    message,
    review,
    primaryAction,
    label,
    disabled:
      busy ||
      loading ||
      !available ||
      intent.status !== "prepared" ||
      (!active.length && stage === "funding" && !review && !depositBudgetAtoms(amount)),
  };
}
