import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Screen } from "@/components/templates/Screen";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import { Surface } from "@/components/molecules/Surface";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { earnProfiles } from "@/domain/earn/types";
import {
  portfolioAssetAmount,
  portfolioVaultPosition,
  vaultNames,
} from "@/domain/wallet/portfolioValue";
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { VaultPositionSummary } from "@/features/wallet/VaultPositionCard";
import { WithdrawalStatusNotice } from "./WithdrawalStatusNotice";
import { useSharedWithdrawalState } from "./useVaultPosition";

/** Viewing an investment does not select or resume a withdrawal cycle. */
export function VaultPositionScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, "VaultPosition">) {
  const { profileId } = route.params;
  const profile = earnProfiles[profileId];
  const portfolio = useMainnetWallet();
  const coverage = useSharedWithdrawalState();
  const position = profile ? portfolioVaultPosition(portfolio.snapshot, profileId) : null;
  const amount = position ? portfolioAssetAmount(position, true) : null;
  const idle = amount !== null && BigInt(amount) === 0n && !coverage.canWithdraw(profileId);
  return (
    <Screen>
      <BackAction fallback="Vaults" />
      <Typography variant="title">
        {profile ? vaultNames[profileId] : "Vault unavailable"}
      </Typography>
      <Surface>
        <View className="gap-3 p-5">
          <Typography variant="heading">Your vault position</Typography>
          {position ? (
            <VaultPositionSummary position={position} loading={portfolio.loading} />
          ) : (
            <Typography>
              {portfolio.loading
                ? "Checking vault position…"
                : "Vault position unavailable. Refresh to check your balance."}
            </Typography>
          )}
        </View>
      </Surface>
      <WithdrawalStatusNotice
        attention={coverage.attentionFor(profileId)}
        onOpenWithdrawal={() => navigation.navigate("VaultWithdrawal", { profileId })}
        canCheckPastReturn={coverage.hasPastReturn(profileId)}
        onCheckPastReturn={() =>
          navigation.navigate("VaultWithdrawal", { profileId, historyOnly: true })
        }
      />
      {!idle && <Typography>Your funds remain invested until you choose to withdraw.</Typography>}
      <Button
        label="Withdraw"
        disabled={!profile || !coverage.canWithdraw(profileId)}
        onPress={() => navigation.navigate("VaultWithdrawal", { profileId })}
      />
      <Button
        label="Refresh position"
        variant="quiet"
        disabled={portfolio.loading}
        onPress={() => void portfolio.refresh()}
      />
    </Screen>
  );
}
