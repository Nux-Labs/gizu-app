import { useCallback, useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import type { EarnIntent } from "@/domain/earn/types";
import {
  SourceFundingBlocked,
  type SourceFundingPreview,
  type SourceFundingPlan,
  type SponsoredOperation,
} from "@/domain/earn/sourceFunding";
import { fixedDecimal } from "@/domain/earn/policy";
import { formatUsdc } from "@/domain/wallet/amounts";
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { PrivatePayoutPanel } from "./PrivatePayoutPanel";
import { useEarn } from "./EarnProvider";
import colors from "@/theme/colors.json";
function useSourceFunding(intent: EarnIntent) {
  const service = useEarn().sourceFunding,
    wallet = useFundingWallet();
  const [budget, setBudget] = useState(""),
    [plans, setPlans] = useState<SourceFundingPlan[]>([]),
    [plan, setPlan] = useState<SourceFundingPlan | null>(null),
    [preview, setPreview] = useState<SourceFundingPreview | null>(null),
    [operations, setOperations] = useState<SponsoredOperation[]>([]),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    occupied = useRef(false),
    controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const attempt = generation.current;
    setLoading(true);
    try {
      const enabled = await service.available();
      if (attempt !== generation.current) return;
      setAvailable(enabled);
      if (enabled && intent.status === "prepared") {
        const rows = await service.list(intent);
        if (attempt === generation.current)
          setOperations(rows.filter((row) => row.kind === "sourceFunding"));
      }
    } catch (error) {
      if (attempt === generation.current) {
        setAvailable(false);
        setMessage(
          error instanceof Error ? error.message : "Saved funding progress is unavailable.",
        );
      }
    } finally {
      if (attempt === generation.current) setLoading(false);
    }
  }, [intent, service]);
  useEffect(() => {
    const attempt = ++generation.current;
    void Promise.resolve().then(() => {
      if (attempt === generation.current) return refresh();
    });
    return () => {
      generation.current = attempt + 1;
      controller.current?.abort();
      service.cancel();
    };
  }, [refresh, service]);
  useEffect(() => {
    const expiresAtMs = plans.length
      ? Math.min(...plans.map((p) => p.expiresAtMs))
      : (plan?.expiresAtMs ?? preview?.expiresAtMs);
    if (!expiresAtMs) return;
    const timer = setTimeout(
      () => {
        setPlan(null);
        setPlans([]);
        setPreview(null);
        setMessage("Source funding fees expired. Review a fresh quote.");
      },
      Math.max(0, expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [plan, plans, preview]);
  const run = async (task: () => Promise<void>) => {
    if (occupied.current) return;
    occupied.current = true;
    const attempt = generation.current;
    setBusy(true);
    setMessage("");
    try {
      await task();
    } catch (error) {
      if (attempt === generation.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "Funding stopped. Reconcile saved progress before retrying.",
        );
    } finally {
      occupied.current = false;
      if (attempt === generation.current) {
        setBusy(false);
      }
      void wallet.refreshAfterAction();
    }
  };
  const update = (next: SponsoredOperation) =>
    setOperations((rows) => [...rows.filter((row) => row.operationId !== next.operationId), next]);
  const review = () =>
    run(async () => {
      setPlan(null);
      setPlans([]);
      if (wallet.loading || wallet.error || wallet.balance === null)
        throw new Error("The source USDC balance is unavailable. Your saved balance is preserved.");
      const amount = fixedDecimal(budget.trim(), 6),
        balance = fixedDecimal(wallet.balance, 6);
      if (amount <= 10000n || amount > balance)
        throw new Error(
          "Choose a USDC budget within the funded balance, including gas and 0.01 USDC retained.",
        );
      const attempt = generation.current,
        abort = new AbortController();
      controller.current = abort;
      setPreview(null);
      try {
        const next = await (
          service.planMany ??
          (async (...args: Parameters<typeof service.plan>) => [await service.plan(...args)])
        )(intent, amount.toString(), balance.toString(), abort.signal);
        if (attempt === generation.current) {
          setPlans(next);
          setPlan(next[0] ?? null);
        }
      } catch (error) {
        if (error instanceof SourceFundingBlocked) {
          if (attempt === generation.current) setPreview(error.preview);
        } else throw error;
      }
    });
  const execute = () =>
    run(async () => {
      const selected = plans.length ? plans : plan ? [plan] : [];
      if (!selected.length) return;
      const attempt = generation.current;
      setPlan(null);
      setPlans([]);
      try {
        const rows = service.executeMany
          ? await service.executeMany(intent, selected)
          : selected.length === 1 && !selected[0]!.fundingBatchId
            ? [await service.execute(intent, selected[0]!)]
            : (() => {
                throw new Error("USDC funding requires the updated native batch signer.");
              })();
        if (attempt === generation.current) {
          rows.forEach(update);
          if (rows.length < selected.length) await refresh();
        }
      } catch (error) {
        if (attempt === generation.current) await refresh();
        throw error;
      }
    });
  const reconcile = (op: SponsoredOperation) =>
    run(async () => {
      const attempt = generation.current;
      const next = await service.reconcileCredit(intent, op);
      if (attempt === generation.current) update(next);
    });
  const resume = (op: SponsoredOperation) =>
    run(async () => {
      const attempt = generation.current;
      try {
        const rows =
          op.fundingBatchId && service.resumeBatch
            ? await service.resumeBatch(intent, op.fundingBatchId)
            : [await service.resume(intent, op)];
        if (attempt === generation.current) {
          rows.forEach(update);
          if (rows.length < (rows[0]?.fundingBatchSize ?? rows.length)) await refresh();
        }
      } catch (error) {
        if (attempt === generation.current) await refresh();
        throw error;
      }
    });
  const cancel = (op: SponsoredOperation) =>
    run(async () => {
      const attempt = generation.current;
      const next = await service.cancelUnsigned(intent, op);
      if (attempt === generation.current) update(next);
    });
  return {
    budget,
    setBudget: (value: string) => {
      setBudget(value);
      setPlan(null);
      setPlans([]);
      setPreview(null);
      setMessage("");
    },
    plan,
    plans,
    preview,
    operations,
    available,
    loading,
    busy,
    message,
    review,
    execute,
    reconcile,
    resume,
    cancel,
    refresh: () => run(refresh),
  };
}
export function SourceFundingPanel({
  intent,
  presentation = "deposit",
}: {
  intent: EarnIntent;
  presentation?: "deposit" | "recovery";
}) {
  const s = useSourceFunding(intent),
    hasFunding = s.operations.some((op) => op.status !== "cancelled" && op.status !== "reverted"),
    disabled =
      s.busy ||
      s.loading ||
      !s.available ||
      intent.status !== "prepared" ||
      (hasFunding && s.plans.length === 0);
  return (
    <Surface>
      <View className="gap-3 p-5">
        {presentation === "deposit" && (
          <>
            <Typography variant="heading">Fund your deposit</Typography>
            <Typography>
              Choose the total Monad USDC budget. Gas is paid in USDC; retain at least 0.01 USDC.
              The 10/90 split uses the actual confirmed confidential credit.
            </Typography>
            <TextInput
              accessibilityLabel="USDC funding budget"
              placeholder="Total USDC budget"
              placeholderTextColor={colors.fg["35"]}
              selectionColor={colors.accent}
              keyboardType="decimal-pad"
              maxLength={85}
              value={s.budget}
              editable={!disabled}
              onChangeText={s.setBudget}
              className="min-h-11 rounded-2xl border border-borderSoft bg-glassSoft px-4 py-3 text-text"
            />
            <Button
              label="Review USDC funding"
              disabled={disabled}
              loading={s.busy}
              onPress={() => void s.review()}
            />
          </>
        )}
        {s.message !== "" && <Typography accessibilityRole="alert">{s.message}</Typography>}
        {!s.available && !s.loading && (
          <Typography>
            Native USDC sponsorship is unavailable in this build. A supported signer and deployed
            provider services are required.
          </Typography>
        )}
        {s.preview && (
          <View className="gap-2">
            <Typography>Unsigned preview — no funds moved</Typography>
            <Typography>Preview source amount: {formatUsdc(s.preview.amountAtoms)} USDC</Typography>
            <Typography>
              Estimated Monad gas bound: {formatUsdc(s.preview.maximumGasAtoms)} USDC
            </Typography>
            {s.preview.minimumCreditAtoms !== null && (
              <Typography>
                Quoted minimum confidential credit: {formatUsdc(s.preview.minimumCreditAtoms)} USDC
              </Typography>
            )}
            {s.preview.providerFeeBps !== null && (
              <Typography>
                Quoted fees: {s.preview.providerFeeBps} basis points, included in the net quote.
              </Typography>
            )}
            {!s.preview.quoteAvailable && (
              <Typography>
                Aurora cannot quote this route right now. No fresh credit or route fee estimate is
                available.
              </Typography>
            )}
            {s.preview.appFees.map((f) => (
              <Typography key={f.recipient} variant="caption">
                {f.recipient}: {f.fee} basis points
              </Typography>
            ))}
            {s.preview.blockers.includes("EARN_AURORA_FEE_UNQUALIFIED") && (
              <Typography>
                Provider fee collectors and referral are awaiting qualification.
              </Typography>
            )}
            {s.preview.blockers.includes("EARN_SETTLEMENT_UNQUALIFIED") && (
              <Typography>
                Operation-specific settlement access is not qualified. Funding is blocked before
                funds move.
              </Typography>
            )}
            {s.preview.blockers.includes("EARN_RECOVERY_UNAVAILABLE") && (
              <Typography>Durable quote recovery is unavailable.</Typography>
            )}
            <Typography variant="caption">
              This estimate cannot be signed. Final gas and executable route terms require a fresh
              native review.
            </Typography>
          </View>
        )}
        {s.plan && !s.plans.some((p) => p.sourceAccountIndex !== undefined) && (
          <>
            <Typography>Source transfer: {formatUsdc(s.plan.quote.amountAtoms)} USDC</Typography>
            <Typography>Maximum Monad gas: {formatUsdc(s.plan.fees.feeCap)} USDC</Typography>
            <Typography>
              Source USDC retained within budget: {formatUsdc(s.plan.fees.remainingBudget)} USDC
            </Typography>
            <Typography>
              Quoted minimum confidential credit: {formatUsdc(s.plan.quote.minimumCreditAtoms)} USDC
            </Typography>
            <Typography variant="caption">
              Aurora quoted fees: {s.plan.quote.providerFeeBps} basis points. Route costs are
              included in the net quote.
            </Typography>
            <Typography variant="caption">
              The native dialog verifies final sponsorship and the exact transfer. A source receipt
              and confidential settlement are checked separately.
            </Typography>
            {s.plan.quote.feePolicy && (
              <Typography variant="caption">
                Fee policy: {s.plan.quote.feePolicy.version}. Gizu fee: 0.
              </Typography>
            )}
            {s.plan.quote.feePolicy?.appFees.map((f) => (
              <Typography key={f.recipient} variant="caption">
                {f.recipient}: {f.fee} basis points
              </Typography>
            ))}
          </>
        )}
        {s.plans.some((plan) => plan.sourceAccountIndex !== undefined) &&
          s.plans.map((plan) => (
            <View key={plan.quote.operationId} className="gap-2">
              <Typography>Funding account {plan.sourceAccountIndex}</Typography>
              <Typography selectable variant="caption">
                {plan.sourceAddress}
              </Typography>
              <Typography>Transfer: {formatUsdc(plan.quote.amountAtoms)} USDC</Typography>
              <Typography>Maximum gas: {formatUsdc(plan.fees.feeCap)} USDC</Typography>
              <Typography>Retained: {formatUsdc(plan.fees.remainingBudget)} USDC</Typography>
              <Typography>
                Quoted minimum credit: {formatUsdc(plan.quote.minimumCreditAtoms)} USDC
              </Typography>
              <Typography variant="caption">
                Aurora quoted fees: {plan.quote.providerFeeBps} basis points.
              </Typography>
              {plan.quote.feePolicy && (
                <Typography variant="caption">
                  Fee policy: {plan.quote.feePolicy.version}. Gizu fee: 0.
                </Typography>
              )}
              {plan.quote.feePolicy?.appFees.map((fee) => (
                <Typography key={fee.recipient} variant="caption">
                  {fee.recipient}: {fee.fee} basis points
                </Typography>
              ))}
            </View>
          ))}
        {(s.plan || s.preview || s.plans[0]) && (
          <Button
            label="Authorize USDC funding"
            disabled={s.busy || s.preview !== null}
            loading={s.busy}
            onPress={() => void s.execute()}
          />
        )}
        {s.busy && !s.plan && (
          <Typography accessibilityLiveRegion="polite">
            Checking funding and saved progress…
          </Typography>
        )}
        {s.operations.map((op) => (
          <View key={op.operationId} className="gap-2">
            <Typography>
              {op.status === "credited"
                ? `Confirmed operation credit: ${formatUsdc(op.creditedAtoms ?? "0")} USDC`
                : op.status === "awaitingSettlement" || op.status === "sourceFunded"
                  ? "USDC sent. Confidential credit is awaiting reconciliation."
                  : op.status === "cancelled"
                    ? "Unsigned source review cancelled."
                    : op.status === "reverted"
                      ? "Source funding reverted. Check saved progress."
                      : "Source submission is unresolved. Reconcile before retrying."}
            </Typography>
            {op.actualTokenFeeAtoms && (
              <Typography>
                Verified source gas paid: {formatUsdc(op.actualTokenFeeAtoms)} USDC
              </Typography>
            )}
            {op.transactionHash && (
              <Typography selectable variant="caption">
                {op.transactionHash}
              </Typography>
            )}
            {(op.status === "awaitingSettlement" || op.status === "sourceFunded") && (
              <Button
                label="Check confidential credit"
                variant="secondary"
                disabled={s.busy}
                onPress={() => void s.reconcile(op)}
              />
            )}
            {op.canCancelPreparation && op.preparationCancellationDisclosure && (
              <Typography>{op.preparationCancellationDisclosure}</Typography>
            )}
            {op.canResume &&
              (!op.fundingBatchId ||
                !s.operations.some(
                  (row, index) =>
                    row.fundingBatchId === op.fundingBatchId &&
                    row.canResume &&
                    index < s.operations.indexOf(op),
                )) && (
                <Button
                  label="Review saved funding"
                  variant="secondary"
                  disabled={s.busy}
                  onPress={() => void s.resume(op)}
                />
              )}
            {(op.canCancelPreparation ?? op.status === "planned") && !op.userOperationHash && (
              <Button
                label={
                  op.status === "authorizationSaved"
                    ? "Discard funding preparation"
                    : "Cancel unsigned funding"
                }
                variant="secondary"
                disabled={s.busy}
                onPress={() => void s.cancel(op)}
              />
            )}
            {op.status === "credited" && (
              <Typography>
                Review the two separate payout routes using this confirmed amount. A quoted minimum
                or aggregate private balance cannot replace it.
              </Typography>
            )}
          </View>
        ))}
        <Button
          label="Check saved funding"
          variant="secondary"
          disabled={s.busy || s.loading}
          onPress={() => void s.refresh()}
        />
        <PrivatePayoutPanel
          intent={intent}
          fundingBlocked={
            s.plans.some((plan) => Boolean(plan.fundingBatchId)) ||
            s.operations.some(
              (op) =>
                op.fundingBatchId &&
                (s.operations.filter((row) => row.fundingBatchId === op.fundingBatchId).length !==
                  op.fundingBatchSize ||
                  s.operations
                    .filter((row) => row.fundingBatchId === op.fundingBatchId)
                    .some((row) => row.status !== "credited")),
            )
          }
          fundings={s.operations.filter((op) => op.status === "credited")}
        />
      </View>
    </Surface>
  );
}
