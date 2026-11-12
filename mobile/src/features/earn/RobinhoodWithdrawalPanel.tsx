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
} from "@/domain/earn/robinhoodExecution";
import { isVaultWithdrawalPlanError } from "@/services/earn/robinhoodExecution";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { formatUsdc } from "@/domain/wallet/amounts";
import { useEarnJournal } from "./useEarnJournal";
import { ExitCompletionPanel } from "./ExitCompletionPanel";

const expiredSponsoredSignature = "Saved sponsored deadline expired";
const resignExpiredSignature =
  "The saved sponsored deadline expired. Please re-sign the transaction";

/** Guided vault exit. Native journals remain authoritative for every retry. */
export function RobinhoodWithdrawalPanel({
  intent,
  service,
  onWithdrawalComplete,
}: {
  intent: EarnIntent;
  service: EarnRobinhoodService;
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
}) {
  const v = useEarnJournal(intent, service);
  const [plan, setPlan] = useState<RobinhoodPlan | null>(null);
  const [expired, setExpired] = useState(false);
  const [details, setDetails] = useState(false);
  const blocking = v.rows.filter((row) => row.blocked);
  const saved = blocking[0];
  const position = [...v.rows]
    .reverse()
    .find((row) => ["invested", "withdrawn", "residualShares"].includes(row.status));
  const returned = [...v.rows]
    .reverse()
    .find(
      (row) => row.kind === "hoodTokenReturn" && !["cancelled", "reverted"].includes(row.status),
    );
  const awaitingCredit =
    returned && ["returnSubmitted", "awaitingSettlement"].includes(returned.status);
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
  const settledRedeem = v.rows.some(
    (row) =>
      row.kind === "hoodRedeemAll" &&
      row.status === "withdrawn" &&
      row.redeemedUsdgAtoms !== undefined &&
      row.redeemedUsdgAtoms !== "0",
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
  const redeemable = position?.status === "invested" || position?.status === "residualShares";

  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, plan.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [plan]);
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
        const next = await service.plan(intent, kind, signal);
        return { next, cancelled };
      },
      ({ next, cancelled }) => {
        if (cancelled) v.update(cancelled);
        setPlan(next);
        setExpired(next.expiresAtMs <= Date.now());
      },
    );
  };
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
        if (
          reviewed.kind === "hoodRedeemAll" &&
          row.status === "withdrawn" &&
          row.redeemedUsdgAtoms !== undefined &&
          row.redeemedUsdgAtoms !== "0"
        ) {
          setPlan(null);
          return { row, next: await service.plan(intent, "hoodTokenReturn", signal) };
        }
        return { row, next: null };
      },
      ({ row, next }) => {
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
            {withdrawn || returned ? "STEP 2 OF 2" : "STEP 1 OF 2"}
          </Typography>
          <Typography variant="cardTitle">
            {withdrawn || returned ? "Return to private balance" : "Withdraw from vault"}
          </Typography>
          <Typography accessibilityLiveRegion="polite">
            {v.loading
              ? "Checking your withdrawal…"
              : !v.available
                ? "Update Gizu to withdraw from this vault. Your investment is still saved."
                : v.busy
                  ? plan
                    ? "Waiting for secure approval…"
                    : "Preparing the next step…"
                  : plan
                    ? expired
                      ? "This review has expired. Refresh it to see current fees."
                      : "Check the amounts below, then continue to the secure approval screen."
                    : fresh
                      ? "Your previous review was not completed. Start a fresh review with current fees. No withdrawal transaction has been submitted."
                      : awaitingCredit
                        ? "Your return is on its way. We will confirm it before marking this withdrawal complete."
                        : saved
                          ? saved.kind === "hoodRedeemAll" && saved.status === "pending"
                            ? "Your vault withdrawal is confirming. The private return opens after the USDG arrives."
                            : savedRedeemAfterSettlement
                              ? expiredSettledRedeem
                                ? "Your funds have left the vault. Return them to your private USDC balance next."
                                : "A vault signature is still saved. It is checked before the private return."
                              : replaceExpiredSignature
                                ? resignExpiredSignature
                                : "Checking your saved transaction"
                          : returned?.status === "minimumReceived"
                            ? "Your minimum return is verified. Check the final balance to finish."
                            : returned?.status === "credited"
                              ? "Your return has been credited. Verify the final balance to finish."
                              : withdrawn
                                ? "Your funds have left the vault. Return them to your private USDC balance next."
                                : redeemable
                                  ? "Your investment is ready to withdraw."
                                  : "Check your saved activity to find the next withdrawal step."}
          </Typography>
        </View>

        {returned?.status === "minimumReceived" && (
          <>
            <Typography>
              At least {formatUsdc(returned.verifiedMinimumAtoms ?? "0")} USDC verified
            </Typography>
            <Typography variant="caption">
              Your full private balance is checked separately and includes any surplus.
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
            </View>
            <Typography variant="caption">
              {plan.kind === "hoodRedeemAll"
                ? "The vault amount can change before confirmation. This redeems all shares in this part; no minimum withdrawal amount is guaranteed. You will approve the private return separately."
                : `Your USDC stays private in Gizu.${plan.route ? ` The quoted return service fee is ${plan.route.providerFeeBps / 100}%.` : ""} A small balance may remain for network costs.`}
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
          (awaitingCredit ? (
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

        {returnConfirmed && !saved && (
          <ExitCompletionPanel
            intent={intent}
            aggregate
            onWithdrawalComplete={onWithdrawalComplete}
          />
        )}
        {v.rows.length > 0 && (
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
                {v.rows.map((row) => (
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
