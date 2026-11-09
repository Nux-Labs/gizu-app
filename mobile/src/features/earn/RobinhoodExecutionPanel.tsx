import { useState } from "react";
import type { EarnInvestmentExitProof } from "@/domain/earn/investmentPositions";
import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { formatUsdc } from "@/domain/wallet/amounts";
import type { EarnIntent } from "@/domain/earn/types";
import type {
  EarnRobinhoodService,
  RobinhoodKind,
  RobinhoodPlan,
} from "@/domain/earn/robinhoodExecution";
import { useEarnJournal } from "./useEarnJournal";
import { ExitCompletionPanel } from "./ExitCompletionPanel";
import { RobinhoodWithdrawalPanel } from "./RobinhoodWithdrawalPanel";
export function RobinhoodExecutionPanel({
  presentation = "legacy",
  ...props
}: {
  intent: EarnIntent;
  service: EarnRobinhoodService;
  presentation?: "legacy" | "investment" | "withdrawal";
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
}) {
  return presentation === "withdrawal" ? (
    <RobinhoodWithdrawalPanel {...props} />
  ) : (
    <LegacyRobinhoodExecutionPanel {...props} presentation={presentation} />
  );
}
function LegacyRobinhoodExecutionPanel({
  intent,
  service,
  presentation = "legacy",
  onWithdrawalComplete,
}: {
  intent: EarnIntent;
  service: EarnRobinhoodService;
  presentation?: "legacy" | "investment" | "withdrawal";
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
}) {
  const v = useEarnJournal(intent, service),
    [plan, setPlan] = useState<RobinhoodPlan | null>(null),
    blocked = v.rows.some((r) => r.blocked),
    lastPosition = [...v.rows]
      .reverse()
      .find((r) => ["invested", "withdrawn", "residualShares"].includes(r.status)),
    invested = lastPosition?.status === "invested",
    residual = lastPosition?.status === "residualShares" && lastPosition.residualShares !== "0",
    withdrawn = lastPosition?.status === "withdrawn",
    returned = v.rows.some(
      (r) => r.kind === "hoodTokenReturn" && r.status !== "cancelled" && r.status !== "reverted",
    ),
    disabled = v.busy || v.loading || !v.available || blocked || intent.status !== "prepared";
  const review = (kind: RobinhoodKind) => {
    setPlan(null);
    void v.perform((signal) => service.plan(intent, kind, signal), setPlan);
  };
  const execute = () => {
    if (plan)
      void v.perform(
        () => service.execute(intent, plan),
        (op) => {
          setPlan(null);
          v.update(op);
        },
      );
  };
  return (
    <Surface>
      <View className="gap-3 p-5">
        <Typography variant="row">
          {presentation === "withdrawal"
            ? "Withdrawal and return"
            : `${intent.distribution ? `Wallet ${(intent.investmentSlot ?? 0) + 1}` : "Wallet 2"} · Robinhood USDG execution`}
        </Typography>
        {v.loading ? (
          <Typography>Checking saved USDG progress…</Typography>
        ) : !v.available ? (
          <Typography>
            USDG execution requires the updated native signer. This build can review balances only.
          </Typography>
        ) : null}
        <Typography>
          Gas is paid in USDG through the paymaster. Approvals and signing remain in the native
          authorization dialog.
        </Typography>
        {presentation === "legacy" && (
          <Button
            label="Review USDG investment"
            disabled={disabled || invested || residual || returned}
            onPress={() => review("hoodDeposit")}
          />
        )}
        {plan && (
          <>
            {plan.kind === "hoodDeposit" ? (
              <>
                <Typography>Deposit: {formatUsdc(plan.amountAtoms)} USDG</Typography>
                <Typography>
                  Withdrawal reserve: {formatUsdc(plan.withdrawalReserveAtoms)} USDG
                </Typography>
                <Typography>
                  The reserve stays liquid. Redemption was simulated only to estimate a future
                  withdrawal; this deposit remains invested.
                </Typography>
              </>
            ) : plan.kind === "hoodRedeemAll" ? (
              <>
                <Typography>
                  Redeem all current {intent.distribution ? "selected wallet" : "wallet 2"} shares.
                  The asset amount depends on the vault at execution; there is no minimum-assets
                  guard.
                </Typography>
                <Typography>
                  This withdrawal uses the existing USDG reserve. A return needs its own fresh quote
                  and authorization after zero shares are confirmed.
                </Typography>
              </>
            ) : (
              <>
                <Typography>Return: {formatUsdc(plan.amountAtoms)} USDG</Typography>
                <Typography>Aurora service fee: 2 basis points</Typography>
                <Typography>
                  Remaining USDG value at most: {formatUsdc(plan.maximumResidualUsdcAtoms ?? "0")}{" "}
                  USDC
                </Typography>
                <Typography>
                  Confidential credit is confirmed separately from the public transfer. Completion
                  needs fresh zero-share and asset reconciliation.
                </Typography>
              </>
            )}
            <Typography>
              Maximum gas payment: {formatUsdc(plan.maximumTokenFeeAtoms)} USDG
            </Typography>
            <Typography variant="caption">
              Reserves are retained funds, not fees already paid. Fees and liquidity can change;
              native execution checks live state again.
            </Typography>
            <Button
              label={
                v.busy
                  ? "Authorizing USDG…"
                  : plan.kind === "hoodDeposit"
                    ? "Authorize USDG deposit"
                    : plan.kind === "hoodRedeemAll"
                      ? "Authorize USDG withdrawal"
                      : "Authorize USDG return"
              }
              disabled={v.busy || blocked}
              loading={v.busy}
              onPress={execute}
            />
            {!v.busy && (
              <Button
                label="Dismiss USDG review"
                variant="secondary"
                onPress={() => setPlan(null)}
              />
            )}
          </>
        )}
        {v.rows.map((op) => (
          <View key={op.operationId} className="gap-2">
            <Typography>
              {op.status === "invested"
                ? "USDG remains invested until you withdraw."
                : op.status === "withdrawn"
                  ? "USDG withdrawal confirmed. Return has not been submitted."
                  : op.status === "residualShares"
                    ? "Shares remain. Review another withdrawal before returning USDG."
                    : op.status === "minimumReceived"
                      ? `At least ${formatUsdc(op.verifiedMinimumAtoms ?? "0")} USDC verified`
                      : op.status === "credited"
                        ? `Confirmed return credit: ${formatUsdc(op.creditedAtoms ?? "0")} USDC`
                        : op.status === "awaitingSettlement" || op.status === "returnSubmitted"
                          ? "USDG sent. Confidential credit is awaiting reconciliation."
                          : op.status === "pending" || op.status === "unknown"
                            ? "USDG submission awaiting reconciliation"
                            : op.status === "reverted"
                              ? "USDG operation reverted. Review saved progress."
                              : op.status === "cancelled"
                                ? "Unsigned USDG review cancelled"
                                : "Native authorization required for the next USDG step"}
            </Typography>
            {op.status === "minimumReceived" && (
              <Typography>
                Your full private balance is checked separately and includes any surplus.
              </Typography>
            )}
            {op.actualTokenFeeAtoms && (
              <Typography>Verified gas paid: {formatUsdc(op.actualTokenFeeAtoms)} USDG</Typography>
            )}
            {op.transactionHash && (
              <Typography selectable variant="caption">
                {op.transactionHash}
              </Typography>
            )}
            {op.canResume && (
              <Button
                label="Review next USDG step"
                variant="secondary"
                disabled={v.busy}
                onPress={() => void v.perform(() => service.resume(intent, op), v.update)}
              />
            )}
            {op.kind === "hoodTokenReturn" &&
              (op.status === "awaitingSettlement" || op.status === "returnSubmitted") && (
                <Button
                  label="Check USDG return credit"
                  variant="secondary"
                  disabled={v.busy}
                  onPress={() =>
                    void v.perform(() => service.reconcileCredit(intent, op), v.update)
                  }
                />
              )}
            {op.canCancelPreparation && op.preparationCancellationDisclosure && (
              <Typography>{op.preparationCancellationDisclosure}</Typography>
            )}
            {(op.canCancelPreparation ?? op.status === "planned") && !op.userOperationHash && (
              <Button
                label={
                  op.status === "authorizationSaved"
                    ? "Discard USDG preparation"
                    : "Cancel unsigned USDG review"
                }
                variant="secondary"
                disabled={v.busy}
                onPress={() => void v.perform(() => service.cancelUnsigned(intent, op), v.update)}
              />
            )}
          </View>
        ))}
        {(invested || residual) && (
          <Button
            label="Withdraw USDG investment"
            variant="secondary"
            disabled={disabled}
            onPress={() => review("hoodRedeemAll")}
          />
        )}
        {withdrawn && !residual && !returned && (
          <Button
            label="Review USDG return"
            variant="secondary"
            disabled={disabled}
            onPress={() => review("hoodTokenReturn")}
          />
        )}
        {(withdrawn || returned) && (
          <ExitCompletionPanel
            intent={intent}
            aggregate={presentation === "withdrawal"}
            onWithdrawalComplete={onWithdrawalComplete}
          />
        )}
        <Button
          label="Check saved USDG progress"
          variant="secondary"
          disabled={v.busy || v.loading || !v.available}
          onPress={() => void v.refresh()}
        />
        {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      </View>
    </Surface>
  );
}
