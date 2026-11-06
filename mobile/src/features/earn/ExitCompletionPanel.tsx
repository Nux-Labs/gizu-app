import { earnWithdrawalService } from "@/services/earn/withdrawal";
import type { EarnWithdrawalService } from "@/domain/earn/withdrawal";
import { useEarnJournal } from "./useEarnJournal";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnExitCompletionService, ExitCompletion } from "@/domain/earn/exitCompletion";
import { createEarnExitCompletionService } from "@/services/earn/exitCompletion";
import { formatUsdc } from "@/domain/wallet/amounts";
import type { EarnInvestmentExitProof } from "@/domain/earn/investmentPositions";
import { investmentDestination } from "@/domain/earn/distribution";
import { useEarn } from "./EarnProvider";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
export function ExitCompletionPanel({
  intent,
  service,
  withdrawal = earnWithdrawalService,
  aggregate = false,
  onWithdrawalComplete,
}: {
  intent: EarnIntent;
  service?: EarnExitCompletionService;
  withdrawal?: EarnWithdrawalService;
  aggregate?: boolean;
  onWithdrawalComplete?: (proof: EarnInvestmentExitProof) => void;
}) {
  const withdrawals = useEarnJournal(intent, withdrawal);
  const portfolio = useOptionalMainnetWallet();
  const earn = useEarn(),
    checker = useMemo(
      () =>
        service ??
        createEarnExitCompletionService(
          process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
          { liquidity: earn.liquidity, robinhood: earn.robinhood },
        ),
      [service, earn.liquidity, earn.robinhood],
    ),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<ExitCompletion | null>(null),
    [message, setMessage] = useState(""),
    active = useRef<AbortController | null>(null);
  useEffect(() => {
    let closed = false;
    void Promise.resolve().then(() => {
      if (!closed) {
        setResult(null);
        setMessage("");
        setBusy(false);
      }
    });
    return () => {
      closed = true;
      active.current?.abort();
      active.current = null;
    };
  }, [intent, checker]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => {
        setResult(null);
        setMessage("Exit check expired. Check again for current balances and return credits.");
      },
      Math.max(0, result.snapshot.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  useEffect(() => {
    if (!onWithdrawalComplete) return;
    const complete =
      result?.complete === true &&
      result.snapshot.expiresAtMs > Date.now() &&
      result.snapshot.profileId === intent.profileId &&
      result.snapshot.owner.toLowerCase() === investmentDestination(intent).address.toLowerCase() &&
      !busy &&
      !withdrawals.busy &&
      !withdrawals.loading &&
      withdrawals.available &&
      !withdrawals.message &&
      result.creditedReturnOperationIds.length > 0 &&
      withdrawals.rows.every(
        (row) => !row.blocked && (row.status === "paid" || row.status === "cancelled"),
      );
    onWithdrawalComplete({
      walletId: intent.walletId,
      intentId: intent.intentId,
      profileId: intent.profileId,
      ...(intent.investmentSlot !== undefined ? { investmentSlot: intent.investmentSlot } : {}),
      expiresAtMs: complete ? result!.snapshot.expiresAtMs : null,
    });
  }, [
    result,
    intent,
    busy,
    withdrawals.rows,
    withdrawals.busy,
    withdrawals.loading,
    withdrawals.available,
    withdrawals.message,
    onWithdrawalComplete,
  ]);
  const check = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult(null);
    setMessage("");
    try {
      const next = await checker.check(intent, controller.signal);
      if (!controller.signal.aborted && withdrawals.available) await withdrawals.refresh();
      if (!controller.signal.aborted) {
        setResult(next);
        void portfolio?.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Exit verification unavailable.");
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };
  return (
    <View className="gap-2">
      <Typography>
        {aggregate
          ? "Verify that this part has reached your private balance before continuing."
          : intent.distribution
            ? "Exit completion checks the selected investment wallet. Check each wallet to complete the whole investment exit."
            : "Exit completion checks wallet 2 only. Wallet 1 holdings are intentionally excluded."}
      </Typography>
      <Typography variant="caption">
        {withdrawals.rows.length === 0
          ? "Proceeds stay in your confidential USDC balance. Withdraw from Gizu separately to make a public payout."
          : "New proceeds stay confidential. Previously authorized public withdrawals keep their saved destinations and must be reconciled."}
      </Typography>
      <Button
        label={
          busy
            ? "Checking balance…"
            : aggregate
              ? "Verify private balance"
              : "Check exit completion"
        }
        variant={aggregate ? (result?.complete ? "quiet" : "primary") : "secondary"}
        disabled={busy}
        loading={busy}
        onPress={() => void check()}
      />
      {result && (
        <>
          <Typography>
            {aggregate
              ? result.complete
                ? "Private return verified for this part."
                : "Some funds are still in the vault or waiting to return. Refresh the activity to continue."
              : result.complete
                ? "Investment exit complete: zero shares, residual value below 0.50 USDC, and every submitted return has authenticated credit."
                : "Investment exit incomplete: shares or asset value remain above the exit threshold."}
          </Typography>
          <Typography variant="caption">
            Current residual value: {formatUsdc(result.snapshot.residualUsdcAtoms)} USDC
          </Typography>
          {result.snapshot.balances.wrappedWei !== "0" && (
            <Typography>Wrapped ETH remains included in this value.</Typography>
          )}
        </>
      )}
      {withdrawals.rows.map((row) => (
        <View key={row.operationId} className="gap-2">
          <Typography>Previously saved public withdrawal · {row.status}</Typography>
          <Typography selectable variant="caption">
            {row.recipient}
          </Typography>
          <Typography>
            {formatUsdc(row.amountAtoms)} USDC · minimum receiving credit{" "}
            {formatUsdc(row.minimumDestinationAtoms)} USDC
          </Typography>
          {row.status === "paid" && (
            <Typography>
              Received {formatUsdc(row.receivedAtoms)} USDC in the Monad receiving account.
            </Typography>
          )}
          {(row.canResume || row.canRefreshUnsigned) && (
            <Button
              label="Review saved Monad withdrawal"
              variant="secondary"
              disabled={withdrawals.busy}
              onPress={() =>
                void withdrawals.perform(() => withdrawal.resume(intent, row), withdrawals.update)
              }
            />
          )}
          {row.blocked && (
            <Button
              label="Check Monad withdrawal settlement"
              variant="secondary"
              disabled={withdrawals.busy}
              onPress={() =>
                void withdrawals.perform(
                  () => withdrawal.reconcile(intent, row),
                  withdrawals.update,
                )
              }
            />
          )}
          {row.status === "planned" && (
            <Button
              label="Cancel unsigned Monad withdrawal"
              variant="secondary"
              disabled={withdrawals.busy}
              onPress={() =>
                void withdrawals.perform(
                  () => withdrawal.cancelUnsigned(intent, row),
                  withdrawals.update,
                )
              }
            />
          )}
        </View>
      ))}
      {withdrawals.available && (!aggregate || withdrawals.rows.length > 0) && (
        <Button
          label="Check saved Monad withdrawals"
          variant="secondary"
          disabled={withdrawals.busy || withdrawals.loading}
          onPress={() => void withdrawals.refresh()}
        />
      )}
      {withdrawals.message && (
        <Typography accessibilityRole="alert">{withdrawals.message}</Typography>
      )}
      {message !== "" && <Typography accessibilityRole="alert">{message}</Typography>}
    </View>
  );
}
