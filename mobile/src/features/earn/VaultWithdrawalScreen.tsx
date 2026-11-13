import { useEffect } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { View } from "react-native";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { earnProfiles } from "@/domain/earn/types";
import { portfolioVaultPosition } from "@/domain/wallet/portfolioValue";
import { formatUsdc } from "@/domain/wallet/amounts";
import { PrivateBalanceRefresh } from "@/features/wallet/PrivateBalanceRefresh";
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useEarn } from "./EarnProvider";
import { useVaultPosition } from "./useVaultPosition";
import { RobinhoodExecutionPanel } from "./RobinhoodExecutionPanel";
import { VaultExecutionPanel } from "./VaultExecutionPanel";

export function VaultWithdrawalScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, "VaultWithdrawal">) {
  const profileId = route.params.profileId;
  const profile = earnProfiles[profileId];
  const portfolio = useMainnetWallet();
  const earn = useEarn();
  const historyOnly = route.params.historyOnly === true;
  const v = useVaultPosition(profileId, historyOnly);
  const refreshAfterAction = portfolio.refreshAfterAction;
  useEffect(() => {
    if (v.message) void refreshAfterAction();
  }, [v.message, refreshAfterAction]);
  const position = profile && portfolioVaultPosition(portfolio.snapshot, profileId);
  const underlying = position?.underlyingAtoms ?? position?.observedUnderlyingAtoms;
  const complete = v.rows.length > 0 && v.completed === v.rows.length;
  const refresh = () => {
    void v.refresh();
    void portfolio.refresh();
  };
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">
        {profileId === "robinhood-usdg"
          ? "Steakhouse USDG"
          : profileId === "ethereum-usdc"
            ? "Pendle USDC"
            : "Vault unavailable"}
      </Typography>
      {historyOnly && <Typography variant="heading">Past return status</Typography>}
      {!historyOnly && (
        <Surface>
          <View className="gap-2 p-5">
            <Typography variant="heading">Your vault position</Typography>
            <Typography>
              {underlying != null
                ? `Deposited: ${formatUsdc(underlying)} ${profile.symbol}`
                : "Deposited amount unavailable"}
            </Typography>
            <Typography>
              {position?.valueUsdcAtoms != null
                ? `Current value: ${formatUsdc(position.valueUsdcAtoms)} USDC`
                : "Current value unavailable"}
            </Typography>
            {position && (!position.complete || position.stale) && (
              <Typography variant="caption">
                {position.stale
                  ? "Last known position. Refresh to check current balances."
                  : "Partial position. Some saved activity is still being checked."}
              </Typography>
            )}
          </View>
        </Surface>
      )}
      <Typography>
        {historyOnly
          ? "This only checks past returns. It cannot start a new withdrawal."
          : "Withdraw to your private USDC balance in Gizu. One approval covers the vault withdrawal and the private return that follows it."}
      </Typography>
      {v.loading && (
        <Typography accessibilityLiveRegion="polite">
          {historyOnly ? "Checking past returns…" : "Checking saved vault withdrawal activity…"}
        </Typography>
      )}
      {!v.loading && !v.message && !v.intent && (
        <Typography>
          {historyOnly
            ? complete
              ? "Past returns complete."
              : "No past returns are saved for this vault."
            : complete
              ? "All saved withdrawals for this vault are complete."
              : "No saved withdrawal activity for this vault."}
        </Typography>
      )}
      {historyOnly && !v.loading && !v.message && v.intent && (
        <Typography>
          A past return still needs confirmation. This does not start another withdrawal.
        </Typography>
      )}
      {!historyOnly &&
        v.intent &&
        (profileId === "robinhood-usdg" ? (
          <RobinhoodExecutionPanel
            key={`${v.intent.intentId}:${v.intent.investmentSlot ?? "legacy"}`}
            intent={v.intent}
            service={earn.robinhood}
            withdrawalStartsAfter={v.newWithdrawalAfter}
            presentation="withdrawal"
            onWithdrawalComplete={v.recordCompletion}
          />
        ) : (
          <VaultExecutionPanel
            key={`${v.intent.intentId}:${v.intent.investmentSlot ?? "legacy"}`}
            intent={v.intent}
            presentation="withdrawal"
            onWithdrawalComplete={v.recordCompletion}
          />
        ))}
      {v.message !== "" && <Typography accessibilityRole="alert">{v.message}</Typography>}
      {historyOnly && v.canMarkReceived && (
        <View className="gap-2">
          <Typography variant="caption">
            If you already received this past return, record it as done. This updates its saved
            status only; it does not move funds or verify a credit receipt.
          </Typography>
          <Button
            label="Mark this return received"
            variant="quiet"
            disabled={v.loading || earn.busy}
            onPress={() => void v.markReceived()}
          />
        </View>
      )}
      <PrivateBalanceRefresh showAmount onReadComplete={() => v.refresh()} />
      {!historyOnly && profileId !== "robinhood-usdg" && v.completed > 0 && (
        <Button
          label="Check past withdrawals"
          variant="quiet"
          disabled={v.loading || earn.busy}
          onPress={() => void v.recheckCompleted()}
        />
      )}
      <Button
        label={
          historyOnly
            ? "Refresh return status"
            : v.readyToContinue
              ? "Continue withdrawal"
              : "Refresh position"
        }
        variant={v.readyToContinue ? "primary" : "quiet"}
        disabled={v.loading || earn.busy}
        onPress={refresh}
      />
    </Screen>
  );
}
