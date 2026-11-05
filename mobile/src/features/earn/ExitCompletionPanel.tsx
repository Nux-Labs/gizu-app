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
import { useEarn } from "./EarnProvider";
export function ExitCompletionPanel({
  intent,
  service,
  withdrawal = earnWithdrawalService,
}: {
  intent: EarnIntent;
  service?: EarnExitCompletionService;
  withdrawal?: EarnWithdrawalService;
}) {
  const withdrawals = useEarnJournal(intent, withdrawal);
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
  const check = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult(null);
    setMessage("");
    try {
      const next = await checker.check(intent, controller.signal);
      if (!controller.signal.aborted) setResult(next);
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
        {intent.distribution
          ? "Exit completion checks the selected investment wallet. Check each wallet to complete the whole investment exit."
          : "Exit completion checks wallet 2 only. Wallet 1 holdings are intentionally excluded."}
      </Typography>
      <Button
        label={busy ? "Checking exit completion…" : "Check exit completion"}
        variant="secondary"
        disabled={busy}
        loading={busy}
        onPress={() => void check()}
      />
      {result && (
        <>
          <Typography>
            {result.complete
              ? "Investment exit complete: zero shares, residual value below 0.50 USDC, and every submitted return has authenticated credit."
              : "Investment exit incomplete: shares or asset value remain above the exit threshold."}
          </Typography>
          <Typography>
            Current residual value: {formatUsdc(result.snapshot.residualUsdcAtoms)} USDC
          </Typography>
          {result.snapshot.balances.wrappedWei !== "0" && (
            <Typography>Wrapped ETH remains included in this value.</Typography>
          )}
        </>
      )}
      {result?.creditedReturns?.map((row) => (
        <Button
          key={row.operationId}
          label={`Review withdrawal to Monad receiving account · ${row.operationId}`}
          variant="secondary"
          disabled={
            withdrawals.busy ||
            withdrawals.loading ||
            !withdrawals.available ||
            withdrawals.rows.some((operation) => operation.returnOperationId === row.operationId)
          }
          onPress={() =>
            void withdrawals.perform(
              () => withdrawal.execute(intent, row.operationId, row.revision),
              withdrawals.update,
            )
          }
        />
      ))}
      {withdrawals.rows.map((row) => (
        <View key={row.operationId} className="gap-2">
          <Typography>Monad receiving withdrawal · {row.status}</Typography>
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
      {withdrawals.available && (
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
