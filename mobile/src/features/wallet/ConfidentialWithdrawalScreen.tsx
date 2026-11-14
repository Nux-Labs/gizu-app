import { createContext, useContext, useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { ArrowUpRight, CircleCheck, Info, LockKeyhole, RefreshCw } from "lucide-react-native";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Spinner } from "@/components/atoms/Spinner";
import { Surface } from "@/components/molecules/Surface";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { BackAction } from "@/navigation/BackAction";
import { formatUsdc } from "@/domain/wallet/amounts";
import {
  privateWithdrawalAtoms,
  type ConfidentialWithdrawalService,
  type ConfidentialWithdrawalStatus,
} from "@/domain/wallet/confidentialWithdrawal";
import { createConfidentialWithdrawalService } from "@/services/wallet/confidentialWithdrawal";
import { useMainnetWallet } from "./MainnetWalletProvider";
import { PrivateBalanceRefresh } from "./PrivateBalanceRefresh";
import { useConfidentialWithdrawal } from "./useConfidentialWithdrawal";
import colors from "@/theme/colors.json";

export const ConfidentialWithdrawalServiceContext =
  createContext<ConfidentialWithdrawalService | null>(null);
const statusLabels: Record<ConfidentialWithdrawalStatus, string> = {
  review: "Review",
  pending: "In progress",
  unknown: "Confirmation needed",
  paid: "Completed",
  cancelled: "Cancelled",
  needsReview: "Review needed",
  conflict: "Needs attention",
};
export function ConfidentialWithdrawalScreen() {
  const portfolio = useMainnetWallet();
  const injected = useContext(ConfidentialWithdrawalServiceContext);
  const service = useMemo(
    () => injected ?? createConfidentialWithdrawalService(portfolio.session.walletId ?? ""),
    [injected, portfolio.session.walletId],
  );
  const w = useConfidentialWithdrawal(service, portfolio.refreshAfterAction);
  const [amount, setAmount] = useState("");
  let amountAtoms = "";
  let amountError = "";
  try {
    amountAtoms = privateWithdrawalAtoms(amount);
  } catch (error) {
    if (amount !== "") amountError = (error as Error).message;
  }
  const cash = portfolio.snapshot?.ownedAssets?.find(
    (row) => row.chainId === 143 && row.token === "confidential:monad-usdc",
  );
  const op = w.operation;
  const terminal = op?.status === "paid" || op?.status === "cancelled";
  const verifiedCash = cash?.complete && !cash.stale && cash.balanceAtoms !== null;
  const cashAtoms = verifiedCash ? cash.balanceAtoms : cash?.observedAtoms;
  const missingTerms = op?.payouts.some((p) => p.minimumDestinationAtoms === "0");
  return (
    <Screen>
      <View className="flex-row items-center justify-between">
        <BackAction fallback="Home" />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Check saved withdrawal"
          accessibilityState={{ disabled: w.loading || w.busy, busy: w.loading }}
          disabled={w.loading || w.busy}
          onPress={() => void w.load()}
          className="h-11 w-11 items-center justify-center rounded-2xl border border-cardEdge bg-well"
        >
          {w.loading ? <Spinner size="sm" /> : <RefreshCw size={18} color={colors.fg["70"]} />}
        </PressableScale>
      </View>
      <Typography variant="pageTitle">Withdraw from Gizu</Typography>
      <Surface>
        <View className="gap-2 p-4">
          <View className="flex-row items-center justify-between gap-3">
            <Typography variant="caption">Private balance</Typography>
            <LockKeyhole size={15} color={colors.accent} />
          </View>
          {cashAtoms !== null && cashAtoms !== undefined ? (
            <Typography variant="value" className="!text-[24px]">
              {formatUsdc(cashAtoms)} USDC
            </Typography>
          ) : (
            <Typography variant="caption">Balance needs verification</Typography>
          )}
          {!verifiedCash && cashAtoms !== null && cashAtoms !== undefined && (
            <Typography variant="caption">Last observed · Refresh to verify</Typography>
          )}
          <PrivateBalanceRefresh />
        </View>
      </Surface>
      {w.loading ? (
        <View className="flex-row items-center gap-3 px-1 py-3">
          <Spinner size="sm" />
          <Typography variant="caption" accessibilityLiveRegion="polite">
            Checking saved withdrawal…
          </Typography>
        </View>
      ) : !w.available ? (
        <Surface>
          <View className="flex-row items-start gap-3 p-4">
            <Info size={20} color={colors.muted} />
            <View className="min-w-0 flex-1 gap-1">
              <Typography variant="rowTitle">Withdrawals unavailable</Typography>
              <Typography variant="caption">Requires an updated Android app.</Typography>
            </View>
          </View>
        </Surface>
      ) : (
        <>
          {op && (
            <Surface>
              <View className="gap-4 p-4">
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <View className="flex-row items-center gap-2">
                    {op.status === "paid" ? (
                      <CircleCheck size={18} color={colors.accent} />
                    ) : (
                      <ArrowUpRight size={18} color={colors.accent} />
                    )}
                    <Typography variant="rowTitle">Public withdrawal</Typography>
                  </View>
                  <View className="rounded-full border border-cardEdge bg-well px-2.5 py-1.5">
                    <Typography variant="rowValue" accessibilityLiveRegion="polite">
                      {statusLabels[op.status]}
                    </Typography>
                  </View>
                </View>
                <View className="gap-1">
                  <Typography variant="value" className="!text-[28px]">
                    {formatUsdc(op.amountAtoms)} USDC
                  </Typography>
                  <Typography variant="caption">Private → Public · Monad</Typography>
                </View>
                <View className="gap-3 border-t border-cardEdge pt-4">
                  {missingTerms ? (
                    <Typography variant="caption" accessibilityRole="alert">
                      {op.canCancel
                        ? "A new payout quote is needed."
                        : "Review remaining payouts. Completed payouts stay complete."}
                    </Typography>
                  ) : (
                    <View className="flex-row flex-wrap items-center justify-between gap-2">
                      <Typography variant="caption">Minimum received</Typography>
                      <Typography variant="cardTitle">
                        {formatUsdc(op.minimumDestinationAtoms)} USDC
                      </Typography>
                    </View>
                  )}
                  {BigInt(op.receivedAtoms) > 0n && (
                    <View className="flex-row flex-wrap items-center justify-between gap-2">
                      <Typography variant="caption">Received so far</Typography>
                      <Typography variant="cardTitle">
                        {formatUsdc(op.receivedAtoms)} USDC
                      </Typography>
                    </View>
                  )}
                </View>
                <HoldingDetails
                  label={`Receiving wallets · ${op.walletCount}`}
                  accessibilityLabel="Withdrawal recipients"
                >
                  {op.payouts.map((p) => (
                    <View key={p.slot} className="gap-1 border-t border-cardEdge pt-3">
                      <Typography variant="caption">
                        Receiving wallet {p.slot + 1} · {p.status}
                      </Typography>
                      <Typography variant="micro">
                        {formatUsdc(p.amountAtoms)} USDC input · minimum{" "}
                        {formatUsdc(p.minimumDestinationAtoms)} USDC received
                      </Typography>
                    </View>
                  ))}
                </HoldingDetails>
                {op.status === "review" && (
                  <Button
                    label="Authorize public withdrawal"
                    disabled={w.busy}
                    loading={w.busy}
                    onPress={() => void w.perform(() => service.execute(op))}
                  />
                )}
                {!terminal && op.status !== "review" && op.canResume && (
                  <Button
                    label="Resume saved withdrawal"
                    disabled={w.busy}
                    loading={w.busy}
                    onPress={() => void w.perform(() => service.resume(op))}
                  />
                )}
                {op.canCancel && (
                  <Button
                    label="Cancel unsigned withdrawal"
                    variant="quiet"
                    disabled={w.busy}
                    onPress={() => void w.perform(() => service.cancel(op))}
                  />
                )}
              </View>
            </Surface>
          )}
          {(!op || terminal) && (
            <Surface>
              <View className="gap-4 p-4">
                <Typography variant="caption">Amount to withdraw</Typography>
                <TextInput
                  accessibilityLabel="Withdrawal amount in USDC"
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  autoCorrect={false}
                  editable={!w.busy}
                  maxLength={28}
                  placeholder="0.00 USDC"
                  placeholderTextColor={colors.fg["35"]}
                  selectionColor={colors.accent}
                  className="min-h-16 rounded-2xl border border-cardEdge bg-well px-4 font-sans text-[28px] text-text"
                />
                {amountError && (
                  <Typography accessibilityRole="alert" variant="caption">
                    {amountError}
                  </Typography>
                )}
                <Button
                  label="Review withdrawal"
                  disabled={!amountAtoms || w.busy || !!w.message}
                  loading={w.busy}
                  onPress={() => void w.perform(() => service.prepare(amountAtoms))}
                />
                <Typography variant="caption" className="text-center">
                  To public Monad wallets · Fees apply
                </Typography>
              </View>
            </Surface>
          )}
        </>
      )}
      {w.message !== "" && (
        <Typography variant="caption" accessibilityRole="alert">
          {w.message}
        </Typography>
      )}
      <HoldingDetails label="How withdrawals work" accessibilityLabel="About public withdrawals">
        <Typography variant="caption">
          Choose an amount to make public. Gizu distributes the payout across fresh receiving
          wallets you own on Monad. Fees reduce the amount received.
        </Typography>
        <Typography variant="caption">
          Incoming and existing public USDC are not used. Native review verifies fresh private
          balances and any reserved funds.
        </Typography>
        <Typography variant="caption">
          Review and approve the exact terms on your device. Pending or unknown payouts must be
          checked before another withdrawal.
        </Typography>
      </HoldingDetails>
    </Screen>
  );
}
