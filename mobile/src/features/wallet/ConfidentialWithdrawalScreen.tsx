import { createContext, useContext, useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { BackAction } from "@/navigation/BackAction";
import { formatUsdc } from "@/domain/wallet/amounts";
import {
  privateWithdrawalAtoms,
  type ConfidentialWithdrawalService,
} from "@/domain/wallet/confidentialWithdrawal";
import { createConfidentialWithdrawalService } from "@/services/wallet/confidentialWithdrawal";
import { useMainnetWallet } from "./MainnetWalletProvider";
import { PrivateBalanceRefresh } from "./PrivateBalanceRefresh";
import { useConfidentialWithdrawal } from "./useConfidentialWithdrawal";
import colors from "@/theme/colors.json";

export const ConfidentialWithdrawalServiceContext =
  createContext<ConfidentialWithdrawalService | null>(null);
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
  return (
    <Screen>
      <BackAction fallback="Home" />
      <Typography variant="title">Withdraw from Gizu</Typography>
      <Surface>
        <View className="gap-3 p-5">
          <Typography variant="heading">Confidential cash</Typography>
          <Typography>
            {cash?.complete && !cash.stale && cash.balanceAtoms !== null
              ? `Confidential cash: ${formatUsdc(cash.balanceAtoms)} USDC`
              : cash?.observedAtoms
                ? `Last observed private cash: ${formatUsdc(cash.observedAtoms)} USDC`
                : "Confidential cash needs verification."}
          </Typography>
          <PrivateBalanceRefresh />
          <Typography variant="caption">
            Choose an amount to make public. Gizu distributes the payout across fresh receiving
            wallets you own on Monad. Fees reduce the amount received.
          </Typography>
          <Typography variant="caption">
            Incoming and existing public USDC are not used. Native review verifies fresh private
            balances and any reserved funds.
          </Typography>
        </View>
      </Surface>
      {w.loading ? (
        <Typography accessibilityLiveRegion="polite">Checking saved withdrawal…</Typography>
      ) : !w.available ? (
        <Typography>Confidential withdrawals require the updated native Android build.</Typography>
      ) : (
        <>
          {op && (
            <Surface>
              <View className="gap-3 p-5">
                <Typography variant="heading">
                  {op.status === "paid" ? "Public withdrawal complete" : "Saved withdrawal"}
                </Typography>
                <Typography>{formatUsdc(op.amountAtoms)} USDC private debit</Typography>
                <Typography>
                  {op.walletCount} fresh receiving {op.walletCount === 1 ? "wallet" : "wallets"}
                </Typography>
                <Typography>
                  {op.payouts.some((p) => p.minimumDestinationAtoms === "0")
                    ? op.canCancel
                      ? "Payout terms unavailable. Resume or cancel this unsigned distribution."
                      : "Remaining payout terms need review. Resume this saved distribution; completed payouts stay complete."
                    : `Minimum received: ${formatUsdc(op.minimumDestinationAtoms)} USDC`}
                </Typography>
                <Typography>Received: {formatUsdc(op.receivedAtoms)} USDC</Typography>
                <Typography accessibilityLiveRegion="polite">
                  Withdrawal status: {op.status}
                </Typography>
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
                    variant="secondary"
                    disabled={w.busy}
                    onPress={() => void w.perform(() => service.cancel(op))}
                  />
                )}
                {!terminal && (
                  <Typography variant="caption">
                    Saved recipients stay the same on retry. Pending or unknown payouts must be
                    reconciled before starting another withdrawal.
                  </Typography>
                )}
              </View>
            </Surface>
          )}
          {(!op || terminal) && (
            <Surface>
              <View className="gap-4 p-5">
                <Typography variant="label11">Amount to withdraw</Typography>
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
                  className="min-h-14 rounded-2xl border border-cardEdge bg-well px-4 font-sans text-[24px] text-text"
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
                <Typography variant="caption">
                  Preparing a distribution does not authorize a payout. Review and approve its exact
                  terms in the native dialog.
                </Typography>
              </View>
            </Surface>
          )}
        </>
      )}
      {w.message !== "" && <Typography accessibilityRole="alert">{w.message}</Typography>}
      <Button
        label="Check saved withdrawal"
        variant="secondary"
        disabled={w.loading || w.busy}
        onPress={() => void w.load()}
      />
    </Screen>
  );
}
