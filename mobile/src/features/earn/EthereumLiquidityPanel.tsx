import { useEffect, useState } from "react";
import type { EarnInvestmentExitProof } from "@/domain/earn/investmentPositions";
import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import type { EarnIntent } from "@/domain/earn/types";
import type { VaultPlan } from "@/domain/earn/vaultExecution";
import type { LiquidityPlan } from "@/domain/earn/ethereumLiquidity";
import { formatMon, formatUsdc } from "@/domain/wallet/amounts";
import { useEarn } from "./EarnProvider";
import { ExitCompletionPanel } from "./ExitCompletionPanel";
import { useEarnJournal } from "./useEarnJournal";
export function EthereumLiquidityPanel({
  intent,
  bootstrapPlan,
  withdrawn,
  aggregate = false,
  onWithdrawalComplete,
}: {
  intent: EarnIntent;
  bootstrapPlan: VaultPlan | null;
  withdrawn: boolean;
  aggregate?: boolean;
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
}) {
  const service = useEarn().liquidity,
    v = useEarnJournal(intent, service),
    [plan, setPlan] = useState<LiquidityPlan | null>(null);
  const blocked = v.rows.some((r) => r.blocked),
    disabled = v.busy || v.loading || !v.available || blocked;
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(() => setPlan(null), Math.max(0, plan.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [plan]);
  if (intent.profileId !== "ethereum-usdc") return null;
  return (
    <View className="gap-3">
      <Typography variant="row">ETH funding and return progress</Typography>
      {bootstrapPlan?.fusionRequired && (
        <Button
          label="Review ETH funding"
          disabled={disabled}
          onPress={() => void v.perform(() => service.bootstrap(intent, bootstrapPlan), setPlan)}
        />
      )}
      {plan && (
        <>
          {plan.proposal.kind === "fusionEthOrder" ? (
            <>
              <Typography>
                Swap {formatUsdc(plan.proposal.inputAtoms)} USDC for at least{" "}
                {formatMon(plan.proposal.minimumEthWei)} ETH.
              </Typography>
              <Typography>
                Embedded resolver budget: {formatMon(plan.resolverOverheadWei ?? "0")} ETH
                equivalent. This cost is counted once in the swap.
              </Typography>
              <Typography>
                The native signer reviews the USDC permit and executable order separately. A
                confirmed fill requires a fresh investment review.
              </Typography>
            </>
          ) : (
            <>
              <Typography>
                Return{" "}
                {plan.proposal.kind === "returnUsdc"
                  ? formatUsdc(plan.proposal.amountAtoms) + " USDC"
                  : formatMon(plan.proposal.amountAtoms) + " ETH"}{" "}
                to your confidential account.
              </Typography>
              <Typography>
                Maximum gas: {formatMon(plan.proposal.maximumGasCostWei)} ETH. Retained for the next
                return: {formatMon(plan.proposal.withdrawalReserveWei)} ETH.
              </Typography>
              <Typography>
                Minimum private credit: {formatUsdc(plan.minimumCreditAtoms ?? "0")} USDC. Aurora
                charges the fees shown in its fresh quote.
              </Typography>
            </>
          )}
          <Button
            label={
              plan.proposal.kind === "fusionEthOrder"
                ? "Authorize ETH funding"
                : "Authorize asset return"
            }
            disabled={disabled}
            loading={v.busy}
            onPress={() => {
              const review = plan;
              setPlan(null);
              void v.perform(() => service.execute(intent, review), v.update);
            }}
          />
        </>
      )}
      {v.rows.map((row) => (
        <View key={row.operationId} className="gap-2">
          <Typography variant="caption">
            {
              {
                fusionEthOrder: "ETH funding swap",
                fusionUsdcApproval: "USDC authorization",
                returnUsdc: "USDC return",
                returnEth: "ETH return",
              }[row.kind]
            }{" "}
            ·{" "}
            {
              {
                planned: "Awaiting approval",
                permitSaved: "Permit saved",
                signed: "Signed",
                unknown: "Submission needs reconciliation",
                pending: "Pending confirmation",
                fusionFilled: "Swap verified",
                approvalFinalized: "Authorization confirmed",
                awaitingSettlement: "Waiting for private credit",
                credited: "Private credit verified",
                minimumReceived: "Minimum private return verified",
                cancelled: "Unsigned review cancelled",
                reverted: "Transaction reverted",
                expired: "Review expired",
                cancellationPending: "Cancellation awaiting confirmation",
                nonceCancelled: "Cancellation confirmed",
              }[row.status]
            }
          </Typography>
          {row.kind === "fusionEthOrder" && (
            <Typography>
              {row.status === "fusionFilled" ? "Verified swap input spent" : "Swap input"}:{" "}
              {formatUsdc(row.amountAtoms)} USDC
            </Typography>
          )}
          {row.receivedEthWei && (
            <Typography>
              Verified ETH balance increase: {formatMon(row.receivedEthWei)} ETH
            </Typography>
          )}
          {row.status === "fusionFilled" && (
            <Typography>
              ETH fill verified on-chain. Refresh the investment review to calculate the deposit
              from current balances.
            </Typography>
          )}
          {row.status === "permitSaved" && (
            <Typography>
              USDC permit saved privately. Review the executable swap order before submission.
            </Typography>
          )}
          {row.status === "awaitingSettlement" && (
            <Typography>
              Origin return confirmed. Private credit still needs authenticated reconciliation.
            </Typography>
          )}
          {row.creditedAtoms && (
            <Typography>Verified returned credit: {formatUsdc(row.creditedAtoms)} USDC</Typography>
          )}
          {row.status === "minimumReceived" && (
            <>
              <Typography>
                At least {formatUsdc(row.verifiedMinimumAtoms ?? "0")} USDC verified
              </Typography>
              <Typography>
                Your full private balance is checked separately and includes any surplus.
              </Typography>
            </>
          )}
          {row.actualFeeWei && (
            <Typography>Verified gas paid: {formatMon(row.actualFeeWei)} ETH</Typography>
          )}
          {(row.transactionHash ?? row.orderHash) && (
            <Typography selectable variant="caption">
              {row.transactionHash ?? row.orderHash}
            </Typography>
          )}
          {row.canCancelPending && (
            <>
              <Typography>
                Cancel the pending transaction with a separately approved gas fee. The original
                transaction can still confirm first; funds remain locked until the final result is
                verified.
              </Typography>
              <Button
                label="Review pending transaction cancellation"
                variant="secondary"
                disabled={v.busy}
                onPress={() => void v.perform(() => service.cancelPending(intent, row), v.update)}
              />
            </>
          )}
          {row.canResume && (
            <Button
              label="Review saved liquidity step"
              variant="secondary"
              disabled={v.busy}
              onPress={() => void v.perform(() => service.resume(intent, row), v.update)}
            />
          )}
          {row.status === "awaitingSettlement" && (
            <Button
              label="Check returned private credit"
              variant="secondary"
              disabled={v.busy}
              onPress={() => void v.perform(() => service.reconcileCredit(intent, row), v.update)}
            />
          )}
          {row.status === "planned" && (
            <Button
              label="Cancel unsigned liquidity review"
              variant="secondary"
              disabled={v.busy}
              onPress={() => void v.perform(() => service.cancelUnsigned(intent, row), v.update)}
            />
          )}
        </View>
      ))}
      {withdrawn && (
        <ExitCompletionPanel
          intent={intent}
          aggregate={aggregate}
          onWithdrawalComplete={onWithdrawalComplete}
        />
      )}
      {withdrawn && (
        <>
          <Typography>
            Return USDC first, then quote the remaining ETH sweep.{" "}
            {aggregate
              ? "Other portions keep their saved withdrawal progress."
              : intent.distribution
                ? "Other investment wallets keep their own progress."
                : "Wallet 1 stays separate."}
          </Typography>
          <Button
            label="Review USDC return"
            disabled={disabled}
            onPress={() =>
              void v.perform((signal) => service.returnPlan(intent, "usdc", signal), setPlan)
            }
          />
          <Button
            label="Review remaining ETH return"
            variant="secondary"
            disabled={disabled}
            onPress={() =>
              void v.perform((signal) => service.returnPlan(intent, "native", signal), setPlan)
            }
          />
        </>
      )}
      <Button
        label="Check liquidity progress"
        variant="secondary"
        disabled={v.busy || v.loading}
        onPress={() => void v.refresh()}
      />
      {v.busy && (
        <Typography accessibilityLiveRegion="polite">
          Checking native liquidity authority…
        </Typography>
      )}
      {v.message && <Typography accessibilityRole="alert">{v.message}</Typography>}
    </View>
  );
}
