import { Image, View } from "react-native";
import { ArrowUpRight } from "lucide-react-native";
import type { OwnedPortfolioPosition } from "@/domain/wallet/storedSigner";
import type { EarnProfileId } from "@/domain/earn/types";
import { vaultNames, vaultNetworks } from "@/domain/wallet/portfolioValue";
import { Typography } from "@/components/atoms/Typography";
import { PressableScale } from "@/components/atoms/PressableScale";
import { protocolLogo } from "@/features/opportunities/protocolLogos";
import { holdingAmount } from "@/features/swap/SwapHoldingsSection";
import colors from "@/theme/colors.json";

/** One vault aggregate; wallet ownership stays behind the native execution boundary. */
export function VaultPositionSummary({
  position,
  loading = false,
}: {
  position: OwnedPortfolioPosition;
  loading?: boolean;
}) {
  const amount = position.complete ? position.underlyingAtoms : null;
  const observed = position.observedUnderlyingAtoms;
  return (
    <View className="gap-1">
      <Typography variant="rowValue">
        {amount !== null && position.decimals !== null
          ? `${holdingAmount(amount, position.decimals)} ${position.symbol} deposited`
          : loading
            ? "Checking vault position…"
            : "Vault balance unavailable. Refresh to retry."}
      </Typography>
      {position.valueUsdcAtoms !== null && (
        <Typography variant="micro">
          {`≈ ${holdingAmount(position.valueUsdcAtoms, 6)} USDC`}
        </Typography>
      )}
      {amount === null && observed && observed !== "0" && position.decimals !== null && (
        <Typography variant="micro">
          {`Last observed: ${holdingAmount(observed, position.decimals)} ${position.symbol}`}
        </Typography>
      )}
      {position.stale && <Typography variant="micro">Updating position value…</Typography>}
    </View>
  );
}

export function VaultPositionCard({
  position,
  profileId,
  loading,
  onPress,
}: {
  position: OwnedPortfolioPosition;
  profileId: EarnProfileId;
  loading: boolean;
  onPress: () => void;
}) {
  const logo = protocolLogo("Morpho", "morpho");
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`View ${vaultNames[profileId]} position`}
      accessibilityHint="View your combined vault position and withdrawal progress"
      onPress={onPress}
      className="gap-4 rounded-card border border-cardEdge bg-card p-5"
    >
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-neon/10">
          {logo && <Image source={logo} className="h-7 w-7" resizeMode="contain" />}
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Typography variant="cardTitle">{vaultNames[profileId]}</Typography>
          <Typography variant="micro">{`Morpho · ${vaultNetworks[profileId]}`}</Typography>
        </View>
        <ArrowUpRight size={19} color={colors.fg["45"]} />
      </View>
      <VaultPositionSummary position={position} loading={loading} />
    </PressableScale>
  );
}
