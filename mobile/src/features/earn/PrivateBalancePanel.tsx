import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { Surface } from "@/components/molecules/Surface";
import { PrivateBalanceRefresh } from "@/features/wallet/PrivateBalanceRefresh";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";

/** Uses the same private balance and read session as Home. */
export function PrivateBalancePanel() {
  const portfolio = useOptionalMainnetWallet();
  if (!portfolio) return null;
  return (
    <Surface>
      <View className="gap-3 p-5">
        <Typography variant="row">Confidential USDC</Typography>
        <Typography variant="caption">
          Your private balance refreshes while this wallet is unlocked. Balance reads do not
          transfer funds.
        </Typography>
        <PrivateBalanceRefresh persistent showAmount />
        <Typography variant="caption">
          This account balance does not confirm credit for a specific deposit or return. Funding and
          cycle completion require separate settlement evidence.
        </Typography>
      </View>
    </Surface>
  );
}
