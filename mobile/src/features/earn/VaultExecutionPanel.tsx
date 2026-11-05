import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import type { EarnIntent } from "@/domain/earn/types";
import type { VaultKind, VaultOperation, VaultPlan } from "@/domain/earn/vaultExecution";
import { formatGwei, formatMon, formatUsdc } from "@/domain/wallet/amounts";
import { EthereumLiquidityPanel } from "./EthereumLiquidityPanel";
import { useEarn } from "./EarnProvider";
function useVaultExecution(intent: EarnIntent) {
  const service = useEarn().vaultExecution;
  const [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [plan, setPlan] = useState<VaultPlan | null>(null),
    [operations, setOperations] = useState<VaultOperation[]>([]),
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
      if (enabled && intent.profileId === "ethereum-usdc" && intent.status === "prepared") {
        const rows = await service.list(intent);
        if (attempt === generation.current) setOperations(rows);
      }
    } catch (error) {
      if (attempt === generation.current) {
        setAvailable(false);
        setMessage(error instanceof Error ? error.message : "Saved progress is unavailable.");
      }
    } finally {
      if (attempt === generation.current) setLoading(false);
    }
  }, [intent, service]);
  useEffect(() => {
    const attempt = ++generation.current;
    void Promise.resolve().then(() => {
      if (generation.current === attempt) return refresh();
    });
    return () => {
      generation.current = attempt + 1;
      controller.current?.abort();
      service.cancel();
    };
  }, [refresh, service]);
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(
      () => {
        setPlan(null);
        setMessage("Investment fees expired. Refresh the review before authorizing.");
      },
      Math.max(0, plan.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [plan]);
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
            : "Earn action stopped. Reconcile saved progress before retrying.",
        );
    } finally {
      occupied.current = false;
      if (attempt === generation.current) setBusy(false);
    }
  };
  const review = (kind: VaultKind) =>
    run(async () => {
      const attempt = generation.current;
      setPlan(null);
      const abort = new AbortController();
      controller.current = abort;
      const next = await service.plan(intent, kind, abort.signal);
      if (attempt === generation.current) setPlan(next);
    });
  const update = (op: VaultOperation) =>
    setOperations((rows) => [...rows.filter((row) => row.operationId !== op.operationId), op]);
  const execute = () =>
    run(async () => {
      if (!plan) return;
      const attempt = generation.current,
        selected = plan;
      setPlan(null);
      try {
        const op = await service.execute(intent, selected);
        if (attempt === generation.current) update(op);
      } catch (error) {
        if (attempt === generation.current) await refresh();
        throw error;
      }
    });
  const resume = (op: VaultOperation) =>
    run(async () => {
      const attempt = generation.current;
      try {
        const next = await service.resume(intent, op);
        if (attempt === generation.current) update(next);
      } catch (error) {
        if (attempt === generation.current) await refresh();
        throw error;
      }
    });
  const cancel = (op: VaultOperation) =>
    run(async () => {
      const attempt = generation.current;
      const next = await service.cancelUnsigned(intent, op);
      if (attempt === generation.current) update(next);
    });
  return {
    available,
    loading,
    busy,
    plan,
    operations,
    message,
    review,
    execute,
    resume,
    cancel,
    refresh: () => run(refresh),
  };
}
export function VaultExecutionPanel({
  intent,
  presentation = "legacy",
}: {
  intent: EarnIntent;
  presentation?: "legacy" | "investment";
}) {
  const v = useVaultExecution(intent),
    blocked = v.operations.some((op) => op.blocked),
    last = v.operations.at(-1),
    invested = last?.status === "invested" || last?.status === "residualShares",
    withdrawn = last?.status === "withdrawn";
  const disabled =
    !v.available ||
    v.loading ||
    v.busy ||
    blocked ||
    intent.status !== "prepared" ||
    intent.profileId !== "ethereum-usdc";
  return (
    <Surface>
      <View className="gap-3 p-5">
        <Typography variant="heading">Investment and recovery</Typography>
        <Typography>
          Earn ends with funds in the vault. Withdrawal simulation estimates the reserve on an
          isolated fork; it does not withdraw your investment.
        </Typography>
        {v.loading && (
          <Typography accessibilityLiveRegion="polite">
            Checking saved investment progress…
          </Typography>
        )}
        {!v.available && !v.loading && (
          <Typography>
            Native vault execution is unavailable in this build. A supported native signer is
            required.
          </Typography>
        )}
        {presentation === "legacy" && (
          <Button
            label="Review investment"
            disabled={disabled || invested || withdrawn}
            loading={v.busy}
            onPress={() => void v.review("vaultDeposit")}
          />
        )}
        {v.plan && (
          <>
            <Typography variant="row">
              {v.plan.kind === "vaultDeposit" ? "Deposit review" : "Withdrawal review"}
            </Typography>
            {v.plan.kind === "vaultDeposit" ? (
              <>
                <Typography>Investable amount: {formatUsdc(v.plan.amountAtoms)} USDC</Typography>
                <Typography>Liquid USDC retained: {formatUsdc(v.plan.liquidAtoms)} USDC</Typography>
                <Typography>
                  Withdrawal reserve: {formatMon(v.plan.withdrawalReserveWei)} ETH
                </Typography>
                {v.plan.fusionRequired && (
                  <Typography>
                    ETH funding required: {formatUsdc(v.plan.bootstrapUsdc)} USDC. Confirm the swap
                    fill and refresh this plan before depositing.
                  </Typography>
                )}
              </>
            ) : (
              <>
                <Typography>
                  Redeem all {intent.distribution ? "selected wallet" : "wallet 2"} shares. The
                  asset amount depends on the vault at execution; there is no minimum-assets guard.
                </Typography>
                <Typography>
                  This withdrawal spends the retained gas reserve. The Aurora return requires its
                  own fresh quote and authorization.
                </Typography>
              </>
            )}
            <Typography>
              Maximum gas price: {formatGwei(v.plan.maxFeePerGasWei)} gwei · priority:{" "}
              {formatGwei(v.plan.priorityFeePerGasWei)} gwei
            </Typography>
            {v.plan.review && (
              <>
                <Typography>
                  Initial wallet balance: {formatUsdc(v.plan.review.initialUsdc)} USDC ·{" "}
                  {formatMon(v.plan.review.initialEthWei)} ETH
                </Typography>
                {v.plan.review.baseFeeWei && (
                  <Typography>
                    Sampled base fee: {formatGwei(v.plan.review.baseFeeWei)} gwei
                  </Typography>
                )}
                {v.plan.review.extraUsableEthWei && (
                  <Typography>
                    ETH remaining above execution and withdrawal budgets:{" "}
                    {formatMon(v.plan.review.extraUsableEthWei)} ETH
                  </Typography>
                )}
                <Typography variant="caption">
                  Fee sample: block {v.plan.review.referenceBlockNumber} ·{" "}
                  {new Date(v.plan.review.quotedAtMs).toLocaleTimeString()}
                </Typography>
              </>
            )}
            <Typography>Maximum gas payment: {formatMon(v.plan.maximumGasCostWei)} ETH</Typography>
            <Typography variant="caption">
              Reserves are retained funds, not fees already paid. Fees and liquidity can change. The
              native dialog checks live state again.
            </Typography>
            <Button
              label={
                v.busy
                  ? "Authorizing…"
                  : v.plan.kind === "vaultDeposit"
                    ? "Authorize deposit"
                    : "Authorize withdrawal"
              }
              disabled={v.busy || v.plan.fusionRequired || blocked}
              loading={v.busy}
              onPress={() => void v.execute()}
            />
          </>
        )}
        {v.busy && !v.plan && <Button label="Authorizing…" disabled loading onPress={() => {}} />}
        {v.operations.map((op) => (
          <View key={op.operationId} className="gap-2">
            <Typography variant="row">
              {op.status === "invested"
                ? "Funds remain invested until you withdraw."
                : op.status === "withdrawn"
                  ? "Vault withdrawal confirmed. Return not submitted."
                  : op.status === "residualShares"
                    ? "Withdrawal confirmed, but shares remain. Review another withdrawal before returning assets."
                    : op.status === "pending"
                      ? "Submission awaiting reconciliation"
                      : op.status === "reverted"
                        ? "Transaction reverted. Review saved progress."
                        : op.status === "cancelled"
                          ? "Unsigned review cancelled"
                          : "Native authorization required for the next step"}
            </Typography>
            <Typography>Verified gas paid: {formatMon(op.actualFeeWei)} ETH</Typography>
            {op.steps.map((step) => (
              <View key={step.index} className="gap-1">
                <Typography variant="caption">
                  Step {step.index + 1} · {step.status}
                  {step.nonceConflict ? " · nonce conflict requires reconciliation" : ""}
                </Typography>
                {step.transactionHash && (
                  <Typography selectable variant="caption">
                    {step.transactionHash}
                  </Typography>
                )}
              </View>
            ))}
            {op.canResume && (
              <Button
                label="Review next step"
                variant="secondary"
                disabled={v.busy}
                onPress={() => void v.resume(op)}
              />
            )}
            {op.blocked && op.steps.every((s) => !s.transactionHash) && (
              <Button
                label="Cancel unsigned review"
                variant="secondary"
                disabled={v.busy}
                onPress={() => void v.cancel(op)}
              />
            )}
          </View>
        ))}
        {invested && (
          <Button
            label="Withdraw investment"
            variant="secondary"
            disabled={disabled}
            onPress={() => void v.review("vaultRedeemAll")}
          />
        )}
        {withdrawn && (
          <Typography>
            {intent.distribution
              ? "Returning the selected wallet’s assets"
              : "Wallet 1 remains separate. Returning wallet 2 assets"}{" "}
            needs zero shares, fresh quotes, gas and authenticated confidential credit.
          </Typography>
        )}
        {intent.profileId === "ethereum-usdc" && (
          <EthereumLiquidityPanel intent={intent} bootstrapPlan={v.plan} withdrawn={withdrawn} />
        )}
        {intent.profileId === "ethereum-usdc" && (
          <Button
            label="Check saved progress"
            variant="secondary"
            disabled={v.busy || v.loading}
            onPress={() => void v.refresh()}
          />
        )}
        {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      </View>
    </Surface>
  );
}
