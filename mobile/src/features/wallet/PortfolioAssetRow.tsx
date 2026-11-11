import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { LockKeyhole } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import type { OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { earnProfiles } from "@/domain/earn/types";
import { portfolioAssetAmount, portfolioAssetValue } from "@/domain/wallet/portfolioValue";
import { holdingAmount } from "@/features/swap/SwapHoldingsSection";
import usdcLogo from "../../../assets/logos/tokens/usdc.png";
import usdgLogo from "../../../assets/logos/tokens/usdg.png";
import monadLogo from "../../../assets/logos/monad-white.png";
import colors from "@/theme/colors.json";

export function PortfolioAssetRow({
  asset,
  position = false,
  loading,
  privateLocked = false,
}: {
  asset: OwnedPortfolioAsset;
  position?: boolean;
  loading: boolean;
  privateLocked?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const amount = portfolioAssetAmount(asset, position);
  const value = portfolioAssetValue(asset, position);
  const token = asset.token.toLowerCase();
  const privateUsdc = asset.chainId === 143 && token === "confidential:monad-usdc";
  const usdc =
    privateUsdc ||
    (asset.chainId === 143 && token === "0x754704bc059f8c67012fed69bc8a327a5aafb603") ||
    (asset.chainId === 1 && token === earnProfiles["ethereum-usdc"].token.toLowerCase());
  const usdg =
    asset.chainId === 4663 && token === earnProfiles["robinhood-usdg"].token.toLowerCase();
  const logo = usdc
    ? usdcLogo
    : usdg
      ? usdgLogo
      : asset.chainId === 143 && token === "native"
        ? monadLogo
        : undefined;
  const formattedAmount =
    amount !== null && asset.decimals !== null
      ? `${holdingAmount(amount, asset.decimals)} ${asset.symbol}`
      : null;
  return (
    <View className="border-b border-cardEdge last:border-b-0">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${asset.symbol} ${position ? "position" : "holding"} details`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((previous) => !previous)}
        className="min-h-16 flex-row items-center justify-between gap-4 py-3"
      >
        <View className="h-11 w-11 items-center justify-center rounded-full bg-well">
          {logo ? (
            <Image
              source={logo}
              accessibilityLabel={`${asset.symbol} logo`}
              className="h-10 w-10 rounded-full"
              resizeMode="contain"
            />
          ) : (
            <View accessibilityLabel={`${asset.symbol} logo unavailable`}>
              <Typography variant="label">{asset.symbol.slice(0, 2).toUpperCase()}</Typography>
            </View>
          )}
          {privateUsdc && (
            <View className="absolute -bottom-1 -right-1 rounded-full bg-card p-1">
              <LockKeyhole size={12} color={colors.text} />
            </View>
          )}
        </View>
        <Typography variant="rowValue">
          {value !== null
            ? `${holdingAmount(value, 6)} USD`
            : (formattedAmount ?? (loading ? "Checking…" : "Unavailable"))}
        </Typography>
      </Pressable>
      {expanded && (
        <View className="gap-3 pb-4">
          <Typography variant="rowTitle">{asset.symbol}</Typography>
          {position && <Typography variant="micro">Vault position</Typography>}
          <Typography>
            {formattedAmount !== null
              ? `${position && "conversionEstimated" in asset && asset.conversionEstimated ? "Estimated underlying: " : ""}${formattedAmount}`
              : privateLocked
                ? "Refresh to check your private USDC."
                : loading
                  ? `Checking ${asset.symbol} balance…`
                  : `${asset.symbol} balance unavailable. Refresh to retry.`}
          </Typography>
          <Typography variant="micro">Chain {asset.chainId}</Typography>
          <Typography variant="micro" selectable>
            {asset.token}
          </Typography>
          <Typography variant="micro">
            Last checked{" "}
            {asset.checkedAt > 0 ? new Date(asset.checkedAt).toLocaleString() : "never"}
          </Typography>
          {value === null && (
            <Typography variant="micro">
              {loading ? "Checking USD value…" : "USD value unavailable."}
            </Typography>
          )}
        </View>
      )}
    </View>
  );
}
