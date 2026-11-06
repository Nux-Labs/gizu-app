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
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useEarn } from "./EarnProvider";
import { useVaultPosition } from "./useVaultPosition";
import { RobinhoodExecutionPanel } from "./RobinhoodExecutionPanel";
import { VaultExecutionPanel } from "./VaultExecutionPanel";

export function VaultPositionScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, "VaultPosition">) {
  const profileId = route.params.profileId;
  const profile = earnProfiles[profileId];
  const portfolio = useMainnetWallet();
  const earn = useEarn();
  const v = useVaultPosition(profileId);
  const position = profile && portfolioVaultPosition(portfolio.snapshot, profileId);
  const underlying = position?.underlyingAtoms ?? position?.observedUnderlyingAtoms;
  const complete = v.rows.length > 0 && v.completed === v.rows.length;
  const completed = v.completed;
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
      <Typography>
        Withdraw to your private USDC balance in Gizu. First release your funds from the vault, then
        approve their return. We will guide you through each part.
      </Typography>
      {v.loading && (
        <Typography accessibilityLiveRegion="polite">
          Checking saved vault withdrawal activity…
        </Typography>
      )}
      {!v.loading && !v.message && !v.intent && (
        <Typography>
          {complete
            ? "All saved withdrawals for this vault are complete."
            : "No saved withdrawal activity for this vault."}
        </Typography>
      )}
      {v.rows.length > 1 && (
        <Typography accessibilityLiveRegion="polite">
          Withdrawal progress: {completed} of {v.rows.length} saved portions complete.
        </Typography>
      )}
      {v.intent &&
        (profileId === "robinhood-usdg" ? (
          <RobinhoodExecutionPanel
            key={`${v.intent.intentId}:${v.intent.investmentSlot ?? "legacy"}`}
            intent={v.intent}
            service={earn.robinhood}
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
      <Button
        label={v.readyToContinue ? "Continue withdrawal" : "Refresh position"}
        variant={v.readyToContinue ? "primary" : "quiet"}
        disabled={v.loading || earn.busy}
        onPress={refresh}
      />
    </Screen>
  );
}
