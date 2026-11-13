import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { formatUsdc } from "@/domain/wallet/amounts";
import { portfolioAssetAmount } from "@/domain/wallet/portfolioValue";
import { useOptionalMainnetWallet } from "./MainnetWalletProvider";

/** Shared read-session unlock; authorized refreshes do not request another passkey. */
export function PrivateBalanceRefresh({
  persistent = false,
  showAmount = false,
  onReadComplete,
}: {
  /** Keep a quiet manual refresh available after a successful read. */
  persistent?: boolean;
  showAmount?: boolean;
  onReadComplete?: () => void | Promise<void>;
}) {
  const portfolio = useOptionalMainnetWallet();
  if (!portfolio) return null;
  const {
    snapshot,
    loading,
    refresh,
    unlockingPrivateBalance,
    privateBalanceError,
    unlockPrivateBalance,
  } = portfolio;
  const locked = snapshot?.confidentialReadState === "locked";
  const asset = snapshot?.ownedAssets?.find(
    (row) => row.chainId === 143 && row.token.toLowerCase() === "confidential:monad-usdc",
  );
  const amount = showAmount && asset ? portfolioAssetAmount(asset) : null;
  const showButton = persistent || locked;
  if (!showButton && !amount && privateBalanceError === "") return null;
  return (
    <View className="gap-2">
      {amount !== null && <Typography>Private USDC: {formatUsdc(amount)}</Typography>}
      {showButton && (
        <>
          {locked && <Typography variant="micro">Unlock to read your private USDC.</Typography>}
          <Button
            label={locked ? "Unlock private balance" : "Refresh private balance"}
            variant="quiet"
            disabled={loading || unlockingPrivateBalance}
            loading={unlockingPrivateBalance}
            onPress={() =>
              void (async () => {
                await (locked ? unlockPrivateBalance() : refresh());
                await onReadComplete?.();
              })()
            }
          />
        </>
      )}
      {privateBalanceError !== "" && (
        <Typography accessibilityRole="alert" variant="negative">
          {privateBalanceError}
        </Typography>
      )}
    </View>
  );
}
