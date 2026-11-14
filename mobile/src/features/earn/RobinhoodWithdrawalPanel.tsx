import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnInvestmentExitProof } from "@/domain/earn/investmentPositions";
import type {
  EarnRobinhoodService,
  RobinhoodKind,
  RobinhoodPlan,
  RobinhoodPlanOptions,
} from "@/domain/earn/robinhoodExecution";
import { isVaultWithdrawalPlanError } from "@/services/earn/robinhoodExecution";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { latestPrivateReturn, privateReturnConfirmed } from "@/domain/earn/sourceFunding";
import { formatUsdc } from "@/domain/wallet/amounts";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { WithdrawalLadder } from "./WithdrawalLadder";
import { useEarnJournal } from "./useEarnJournal";

const expiredSponsoredSignature = "Saved sponsored deadline expired";
const resignExpiredSignature =
  "The saved sponsored deadline expired. Please re-sign the transaction";

/** Guided vault exit. Native journals remain authoritative for every retry. */
export function RobinhoodWithdrawalPanel({
  intent,
  service,
  onWithdrawalComplete,
  withdrawalStartsAfter,
  withdrawalOptions,
  initialPlan,
  onBusyChange,
}: {
  intent: EarnIntent;
  service: EarnRobinhoodService;
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
  withdrawalStartsAfter?: string;
  withdrawalOptions?: RobinhoodPlanOptions;
  initialPlan?: RobinhoodPlan;
  onBusyChange?: (busy: boolean) => void;
}) {
  const v = useEarnJournal(intent, service);
  const refreshAfterAction = useOptionalMainnetWallet()?.refreshAfterAction;
  const [plan, setPlan] = useState<RobinhoodPlan | null>(initialPlan ?? null);
  const [expired, setExpired] = useState(false);
  const [details, setDetails] = useState(false);
  const completedAt = withdrawalStartsAfter
    ? v.rows.findIndex((row) => row.operationId === withdrawalStartsAfter)
    : -1;
  const currentRows = completedAt >= 0 ? v.rows.slice(completedAt + 1) : v.rows;
  const requestId = withdrawalOptions?.withdrawalRequestId;
  const redeemIds = new Set(
    currentRows
      .filter((row) => row.withdrawalRequestId === requestId)
      .map((row) => row.operationId),
  );
  const flowRows = requestId
    ? currentRows.filter(
        (row) =>
          row.kind === "hoodDeposit" ||
          row.withdrawalRequestId === requestId ||
          (row.withdrawalOperationId && redeemIds.has(row.withdrawalOperationId)),
      )
    : currentRows;
  const blocking = flowRows.filter((row) => row.blocked);
  const saved = blocking[0];
  const retiredRequestedRedeem = [...flowRows]
    .reverse()
    .find(
      (row) => row.kind === "hoodRedeemAll" && row.status === "expired" && row.withdrawalRequestId,
    );
  const position = [...flowRows]
    .reverse()
    .find((row) => ["invested", "withdrawn", "residualShares"].includes(row.status));
  const returned = latestPrivateReturn(flowRows);
  const awaitingCredit =
    returned && ["returnSubmitted", "awaitingSettlement"].includes(returned.status);
  const refunded = returned?.status === "refunded";
  const providerFailed = returned?.providerRouteStatus === "FAILED";
  const returnConfirmed = returned && ["credited", "minimumReceived"].includes(returned.status);
  // A still-valid signature is resumed. Only an already expired exit signature can
  // open a new review, and native code must prove it was never submitted.
  const fresh =
    saved &&
    blocking.length === 1 &&
    !saved.userOperationHash &&
    ["planned", "authorizationSaved"].includes(saved.status) &&
    (saved.canCancelPreparation ?? saved.status === "planned") &&
    (saved.kind === "hoodRedeemAll" || saved.kind === "hoodTokenReturn");
  const disabled = v.busy || v.loading || !v.available || intent.status !== "prepared";
  const settledRedeem = flowRows.some(
    (row) => row.kind === "hoodRedeemAll" && row.status === "withdrawn",
  );
  const savedRedeemAfterSettlement = settledRedeem && saved?.kind === "hoodRedeemAll";
  const expiredSettledRedeem =
    savedRedeemAfterSettlement &&
    (saved?.signatureExpired === true || v.message === expiredSponsoredSignature);
  const replaceExpiredSignature =
    !savedRedeemAfterSettlement &&
    (v.message === "" || v.message === expiredSponsoredSignature) &&
    (saved?.signatureExpired === true || v.message === expiredSponsoredSignature) &&
    (saved?.kind === "hoodRedeemAll" || saved?.kind === "hoodTokenReturn");
  const replacingExpiredSignature =
    plan !== null &&
    blocking.length === 1 &&
    blocking[0]?.status === "signed" &&
    blocking[0]?.kind === plan.kind &&
    (plan.kind === "hoodRedeemAll" || plan.kind === "hoodTokenReturn");
  const withdrawn = position?.status === "withdrawn";
  const redeemable =
    position?.status === "invested" ||
    position?.status === "residualShares" ||
    Boolean((withdrawalStartsAfter || withdrawalOptions || retiredRequestedRedeem) && !position);
  const privateReturned = privateReturnConfirmed(flowRows);
  useEffect(() => {
    onBusyChange?.(v.busy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, v.busy]);

  useEffect(() => {
    if (!privateReturned || !onWithdrawalComplete) return;
    void refreshAfterAction?.();
    onWithdrawalComplete({
      walletId: intent.walletId,
      intentId: intent.intentId,
      profileId: intent.profileId,
      investmentSlot: intent.investmentSlot,
      expiresAtMs: null,
      settled: returned?.status === "minimumReceived",
    });
  }, [privateReturned, onWithdrawalComplete, intent, returned?.status, refreshAfterAction]);

  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, plan.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [plan]);
  useEffect(() => {
    const watched = awaitingCredit
      ? returned
      : saved &&
          (["pending", "unknown"].includes(saved.status) ||
            (saved.status === "signed" && saved.userOperationHash && !saved.signatureExpired))
        ? saved
        : null;
    if (!watched || v.loading || v.busy) return;
    const timer = setTimeout(() => {
      void v.perform(
        async (signal) => {
          const rows = await service.list(intent);
          if (signal.aborted) throw new Error("Status check stopped.");
          const next = rows.find((row) => row.operationId === watched.operationId) ?? watched;
          if (
            next.kind === "hoodTokenReturn" &&
            next.providerRouteStatus === "SUCCESS" &&
            ["returnSubmitted", "awaitingSettlement"].includes(next.status)
          )
            return service.reconcileCredit(intent, next);
          return next;
        },
        v.update,
        false,
      );
    }, 5000);
    return () => clearTimeout(timer);
  }, [awaitingCredit, returned, saved, v, service, intent]);

  const review = (kind: RobinhoodKind, previous?: SponsoredOperation) => {
    setPlan(null);
    setExpired(false);
    void v.perform(
      async (signal) => {
        const cancelled = previous ? await service.cancelUnsigned(intent, previous) : null;
        if (signal.aborted) throw new Error("Review stopped.");
        if (cancelled && (cancelled.status !== "cancelled" || cancelled.blocked))
          throw new Error(
            "The previous review could not be cleared. Check its status before continuing.",
          );
        const sourceOptions =
          kind === "hoodTokenReturn" && position?.withdrawalRequestId && position.redeemedUsdgAtoms
            ? {
                withdrawalOperationId: position.operationId,
                returnBudgetAtoms: position.redeemedUsdgAtoms,
                minimumRetainedUsdgAtoms: position.minimumRetainedUsdgAtoms,
              }
            : undefined;
        const restored = previous ?? saved ?? retiredRequestedRedeem;
        const savedOptions =
          restored?.kind === "hoodRedeemAll" && restored.withdrawalRequestId
            ? {
                withdrawalRequestId: restored.withdrawalRequestId,
                requestedWithdrawalAtoms: restored.requestedWithdrawalAtoms,
                withdrawAllShares: restored.withdrawAllShares,
              }
            : undefined;
        const planOptions =
          plan?.kind === "hoodRedeemAll" && plan.withdrawalRequestId
            ? {
                withdrawalRequestId: plan.withdrawalRequestId,
                requestedWithdrawalAtoms: plan.requestedWithdrawalAtoms,
                withdrawAllShares: plan.withdrawAllShares,
              }
            : undefined;
        const options =
          kind === "hoodRedeemAll"
            ? (withdrawalOptions ?? planOptions ?? savedOptions)
            : sourceOptions;
        const next = options
          ? await service.plan(intent, kind, signal, options)
          : await service.plan(intent, kind, signal);
        return { next, cancelled };
      },
      ({ next, cancelled }) => {
        if (cancelled) v.update(cancelled);
        setPlan(next);
        setExpired(next.expiresAtMs <= Date.now());
      },
    );
  };
  const quotePrivateReturn = (row: SponsoredOperation, signal: AbortSignal) =>
    row.withdrawalRequestId
      ? service.plan(intent, "hoodTokenReturn", signal, {
          withdrawalOperationId: row.operationId,
          returnBudgetAtoms: row.redeemedUsdgAtoms,
          minimumRetainedUsdgAtoms: row.minimumRetainedUsdgAtoms,
        })
      : service.plan(intent, "hoodTokenReturn", signal);
  const execute = () => {
    if (!plan) return;
    if (expired || plan.expiresAtMs <= Date.now()) {
      setExpired(true);
      return;
    }
    const reviewed = plan;
    void v.perform(
      async (signal) => {
        let row: SponsoredOperation;
        try {
          row = await service.execute(intent, reviewed);
        } catch (error) {
          if (!signal.aborted) setPlan(null);
          throw error;
        }
        if (reviewed.kind === "hoodRedeemAll" && service.finishWithdrawal) {
          const outcome = await service.finishWithdrawal(intent, row, signal).catch((error) => {
            if (!signal.aborted) setPlan(null);
            throw error;
          });
          if (outcome.signed) return { row: outcome.signed, redeem: outcome.row, next: null };
          if (outcome.row.status === "withdrawn") {
            setPlan(null);
            return {
              row: outcome.row,
              next: await quotePrivateReturn(outcome.row, signal),
            };
          }
          return { row: outcome.row, next: null };
        }
        if (reviewed.kind === "hoodRedeemAll" && row.status === "withdrawn") {
          setPlan(null);
          return { row, next: await quotePrivateReturn(row, signal) };
        }
        return { row, next: null };
      },
      ({ row, next, redeem }) => {
        if (redeem) v.update(redeem);
        v.update(row);
        setPlan(next);
        setExpired(next !== null && next.expiresAtMs <= Date.now());
      },
    );
  };

  return (
    <Surface>
      <View className="gap-4 p-5">
        <View className="gap-2">
          <Typography variant="eyebrow">
            {withdrawn && !returned ? "Finish withdrawal" : "Withdrawal"}
          </Typography>
          <Typography variant="cardTitle">
            {privateReturned
              ? "Private USDC received"
              : withdrawn || returned
                ? "Return to private balance"
                : "Withdraw to private USDC"}
          </Typography>
          <Typography accessibilityLiveRegion="polite">
            {v.loading
              ? "Checking your withdrawal…"
              : !v.available
                ? "Update Gizu to withdraw from this vault. Your investment is still saved."
                : v.busy
                  ? awaitingCredit
                    ? "Your funds are being sent to your confidential wallet. Waiting for private USDC receipt."
                    : plan?.kind === "hoodRedeemAll"
                      ? "Your vault withdrawal is confirming. Private USDC follows from this approval."
                      : plan
                        ? "Waiting for secure approval…"
                        : "Checking withdrawal progress…"
                  : plan
                    ? expired
                      ? "This review has expired. Refresh it to see current fees."
                      : "Check the amounts below, then continue to the secure approval screen."
                    : fresh
                      ? "Your previous review was not completed. Start a fresh review with current fees. No withdrawal transaction has been submitted."
                      : refunded
                        ? "Aurora returned your funds. You can try again."
                        : providerFailed
                          ? "Aurora could not complete the private return. Your saved transfer is being checked."
                          : awaitingCredit
                            ? "Your funds are being sent to your confidential wallet. Waiting for private USDC receipt."
                            : saved
                              ? saved.kind === "hoodRedeemAll" && saved.status === "pending"
                                ? "Your vault withdrawal is confirming. Private USDC follows from this approval."
                                : saved.kind === "hoodTokenReturn" &&
                                    ["pending", "unknown", "signed"].includes(saved.status)
                                  ? "Returning your USDG to private USDC."
                                  : savedRedeemAfterSettlement
                                    ? expiredSettledRedeem
                                      ? "Your funds have left the vault. Return them to your private USDC balance next."
                                      : "A vault signature is still saved. It is checked before the private return."
                                    : replaceExpiredSignature
                                      ? resignExpiredSignature
                                      : "Checking your saved transaction"
                              : privateReturned
                                ? "Private USDC return verified."
                                : returnConfirmed
                                  ? "Shielding your balance."
                                  : withdrawn
                                    ? "Your funds have left the vault. Return them to your private USDC balance next."
                                    : redeemable
                                      ? "Your investment is ready to withdraw."
                                      : "Check your saved activity to find the next withdrawal step."}
          </Typography>
        </View>

        <WithdrawalLadder
          withdrawn={withdrawn || Boolean(returned)}
          quoteReady={plan?.kind === "hoodTokenReturn" || Boolean(returned)}
          sent={Boolean(
            !(refunded && plan?.kind === "hoodTokenReturn") &&
            returned &&
            [
              "awaitingSettlement",
              "returnSubmitted",
              "minimumReceived",
              "credited",
              "refunded",
            ].includes(returned.status),
          )}
          received={privateReturned}
          paused={
            ((refunded || providerFailed) && plan?.kind !== "hoodTokenReturn") ||
            Boolean(v.message) ||
            Boolean(returned?.routeReadUnavailable)
          }
          started={
            v.busy ||
            (plan?.kind !== "hoodTokenReturn" && Boolean(returned)) ||
            Boolean(saved?.userOperationHash) ||
            (withdrawn && !returned && plan?.kind !== "hoodTokenReturn")
          }
        />
        {returned && (
          <Typography variant="caption">
            Sent for confidential conversion: {formatUsdc(returned.amountAtoms)} USDG
          </Typography>
        )}
        {awaitingCredit && returned?.minimumExpectedCreditAtoms && (
          <Typography>
            Expected at least {formatUsdc(returned.minimumExpectedCreditAtoms)} private USDC
          </Typography>
        )}
        {returned?.returnPublicUsdgAtoms !== undefined && (
          <Typography>
            Available in this investment wallet: {formatUsdc(returned.returnPublicUsdgAtoms)} USDG
          </Typography>
        )}
        {awaitingCredit && returned?.routeReadUnavailable && (
          <Typography accessibilityRole="alert">
            Aurora’s latest status is unavailable. Your saved transfer is retained; checking again
            will not send funds again.
          </Typography>
        )}
        {refunded && (
          <Typography variant="caption">
            Your funds are public USDG again. Trying again requests a fresh private-return quote and
            approval; it does not withdraw from the vault again.
          </Typography>
        )}
        {returned?.status === "minimumReceived" && (
          <>
            <Typography>
              At least {formatUsdc(returned.verifiedMinimumAtoms ?? "0")} USDC verified
            </Typography>
            <Typography variant="caption">
              This is the verified minimum. Your private USDC total includes any surplus.
            </Typography>
          </>
        )}

        {v.message !== "" &&
          !replaceExpiredSignature &&
          !(settledRedeem && isVaultWithdrawalPlanError(v.message)) && (
            <Typography accessibilityRole="alert" variant="negative">
              {v.message}
            </Typography>
          )}
        {fresh && !plan && saved.preparationCancellationDisclosure && (
          <Typography variant="caption">
            Any wallet setup permission you already approved stays saved. Starting again does not
            revoke it.
          </Typography>
        )}
        {fresh && !plan && (
          <Typography variant="caption">
            Starting again replaces only the unfinished review. You will approve the new amounts
            separately.
          </Typography>
        )}

        {plan ? (
          <>
            <View className="gap-3 rounded-2xl bg-well p-4">
              <View className="gap-1">
                <Typography variant="caption">
                  {plan.kind === "hoodRedeemAll"
                    ? "Estimated vault withdrawal · this part"
                    : "Minimum private USDC credit · this part"}
                </Typography>
                <Typography variant="value">
                  {plan.kind === "hoodRedeemAll"
                    ? `${formatUsdc(plan.previewRedeemedUsdg ?? "0")} USDG`
                    : `${formatUsdc(plan.route?.minimumCreditAtoms ?? "0")} USDC`}
                </Typography>
              </View>
              <Typography variant="caption">
                Network fee up to {formatUsdc(plan.maximumTokenFeeAtoms)} USDG
              </Typography>
              {plan.kind === "hoodTokenReturn" && plan.withdrawalReserveAtoms !== "0" && (
                <Typography variant="caption">
                  Retained for the next withdrawal: {formatUsdc(plan.withdrawalReserveAtoms)} USDG
                </Typography>
              )}
            </View>
            <Typography variant="caption">
              {plan.kind === "hoodRedeemAll"
                ? plan.requestedWithdrawalAtoms
                  ? "Withdraws this portion to private USDC. Remaining shares stay invested. Final amounts may change."
                  : "Withdraws all shares to private USDC. Final amounts may change; no minimum is guaranteed."
                : `Returns to private USDC.${plan.route ? ` Service fee: ${plan.route.providerFeeBps / 100}%.` : ""} A small network reserve may remain.`}
            </Typography>
            <Button
              label={
                expired
                  ? "Refresh review"
                  : plan.kind === "hoodRedeemAll"
                    ? "Confirm withdrawal"
                    : "Confirm private return"
              }
              disabled={
                disabled ||
                (blocking.length > 0 && !replacingExpiredSignature && !expiredSettledRedeem)
              }
              loading={v.busy}
              onPress={() => (expired ? review(plan.kind) : execute())}
            />
            <Button label="Back" variant="quiet" disabled={v.busy} onPress={() => setPlan(null)} />
          </>
        ) : (
          !v.loading &&
          v.available &&
          (refunded ? (
            <Button
              label="Try private return again"
              disabled={disabled}
              loading={v.busy}
              onPress={() => review("hoodTokenReturn")}
            />
          ) : awaitingCredit ? (
            <Button
              label="Check private return"
              disabled={disabled}
              loading={v.busy}
              onPress={() =>
                void v.perform(() => service.reconcileCredit(intent, returned), v.update)
              }
            />
          ) : fresh ? (
            <Button
              label="Start a fresh review"
              disabled={disabled}
              loading={v.busy}
              onPress={() => review(saved.kind as RobinhoodKind, saved)}
            />
          ) : saved && !expiredSettledRedeem ? (
            <Button
              label={
                saved.canResume && !savedRedeemAfterSettlement
                  ? "Continue saved transaction"
                  : "Check withdrawal status"
              }
              disabled={disabled}
              loading={v.busy}
              onPress={() =>
                savedRedeemAfterSettlement
                  ? void v.refresh()
                  : replaceExpiredSignature
                    ? review(saved.kind as RobinhoodKind)
                    : saved.canResume
                      ? void v.perform(() => service.resume(intent, saved), v.update)
                      : void v.refresh()
              }
            />
          ) : returnConfirmed ? null : redeemable && !settledRedeem ? (
            <Button
              label="Review withdrawal"
              disabled={disabled}
              loading={v.busy}
              onPress={() => review("hoodRedeemAll")}
            />
          ) : withdrawn ? (
            <Button
              label="Review private return"
              disabled={disabled}
              loading={v.busy}
              onPress={() => review("hoodTokenReturn")}
            />
          ) : (
            <Button
              label="Check withdrawal status"
              disabled={disabled}
              loading={v.busy}
              onPress={() => void v.refresh()}
            />
          ))
        )}

        {flowRows.length > 0 && (
          <>
            <Button
              label={details ? "Hide activity details" : "Activity details"}
              variant="quiet"
              onPress={() => setDetails(!details)}
            />
            {details && (
              <View className="gap-3 border-t border-borderSoft pt-3">
                {fresh && saved.preparationCancellationDisclosure && (
                  <Typography variant="caption">
                    {saved.preparationCancellationDisclosure}
                  </Typography>
                )}
                {flowRows.map((row) => (
                  <View key={row.operationId} className="gap-1">
                    <Typography variant="caption">
                      {row.kind === "hoodDeposit"
                        ? "Investment"
                        : row.kind === "hoodRedeemAll"
                          ? "Vault withdrawal"
                          : "Private return"}{" "}
                      · {row.status}
                    </Typography>
                    {row.actualTokenFeeAtoms && (
                      <Typography variant="caption">
                        Network fee paid: {formatUsdc(row.actualTokenFeeAtoms)} USDG
                      </Typography>
                    )}
                    {row.transactionHash && (
                      <Typography variant="micro" selectable>
                        {row.transactionHash}
                      </Typography>
                    )}
                  </View>
                ))}
                <Button
                  label="Refresh activity"
                  variant="quiet"
                  disabled={disabled}
                  onPress={() => void v.refresh()}
                />
              </View>
            )}
          </>
        )}
      </View>
    </Surface>
  );
}
