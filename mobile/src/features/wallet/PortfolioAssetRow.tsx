import { displayAmount, holdingAmount } from "@/domain/wallet/amounts";
import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { LockKeyhole } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Button } from "@/components/atoms/Button";
import type { NamedPortfolioAsset } from "./usePortfolioTokenNames";
import { earnProfiles } from "@/domain/earn/types";
import { portfolioAssetAmount, portfolioAssetValue } from "@/domain/wallet/portfolioValue";
import usdcLogo from "../../../assets/logos/tokens/usdc.png";
import usdgLogo from "../../../assets/logos/tokens/usdg.png";
import monadLogo from "../../../assets/logos/monad-white.png";
import colors from "@/theme/colors.json";

export type PortfolioAssetAction = {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
};

const usdPrice = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function PortfolioAssetRow({
  asset,
  position = false,
  loading,
  privateLocked = false,
  actions = [],
}: {
  asset: NamedPortfolioAsset;
  position?: boolean;
  loading: boolean;
  privateLocked?: boolean;
  /** Shortcuts shown when the row is open, such as selling a stock or receiving USDC. */
  actions?: PortfolioAssetAction[];
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
        : asset.logoURI
          ? { uri: asset.logoURI }
          : undefined;
  const formattedAmount =
    amount !== null && asset.decimals !== null
      ? `${displayAmount(amount, asset.decimals)} ${asset.symbol}`
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
        <View className="flex-1 items-end gap-0.5">
          <Typography variant="rowValue">
            {value !== null
              ? `${holdingAmount(value, 6)} USD`
              : (formattedAmount ?? (loading ? "Checking…" : "Unavailable"))}
          </Typography>
          {/* A priced stock shows how many shares the value stands for; USD stablecoins need not. */}
          {value !== null && formattedAmount !== null && !usdc && !usdg && (
            <Typography variant="micro">{formattedAmount}</Typography>
          )}
        </View>
      </Pressable>
      {expanded && asset.fromSwap && (
        <StockDetail
          asset={asset}
          amount={
            amount !== null && asset.decimals !== null
              ? displayAmount(amount, asset.decimals)
              : null
          }
          loading={loading}
          actions={actions}
        />
      )}
      {expanded && !asset.fromSwap && (
        <View className="gap-3 pb-4">
          <Typography variant="rowTitle">{asset.symbol}</Typography>
          {asset.name && <Typography variant="caption">{asset.name}</Typography>}
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
          <AssetActions actions={actions} />
        </View>
      )}
    </View>
  );
}

function AssetActions({ actions }: { actions: PortfolioAssetAction[] }) {
  if (actions.length === 0) return null;
  return (
    <View className="flex-row gap-3 pt-1">
      {actions.map((action) => (
        <View key={action.label} className="flex-1">
          <Button
            label={action.label}
            accessibilityLabel={action.accessibilityLabel}
            variant="secondary"
            onPress={action.onPress}
          />
        </View>
      ))}
    </View>
  );
}

function Stat({
  label,
  value,
  accessibilityLabel,
}: {
  label: string;
  value: string;
  accessibilityLabel?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? `${label} ${value}`}
      className="flex-1 gap-1.5 rounded-2xl bg-well p-4"
    >
      <Typography variant="label11" className="uppercase">
        {label}
      </Typography>
      <Typography variant="value" numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Typography>
    </View>
  );
}

/** A stock's detail: what it is and its market price; the row already shows value and shares. */
function StockDetail({
  asset,
  amount,
  loading,
  actions,
}: {
  asset: NamedPortfolioAsset;
  amount: string | null;
  loading: boolean;
  actions: PortfolioAssetAction[];
}) {
  return (
    <View className="gap-4 pb-4">
      <View className="gap-0.5">
        <Typography variant="cardTitle">{asset.name ?? asset.symbol}</Typography>
        {asset.name ? <Typography variant="caption">{asset.symbol}</Typography> : null}
      </View>
      <View className="flex-row">
        {asset.priceUsd !== undefined ? (
          <Stat label="Market price" value={usdPrice.format(asset.priceUsd)} />
        ) : (
          <Stat label="Market price" value="—" accessibilityLabel="Market price unavailable" />
        )}
      </View>
      {amount === null && !loading && (
        <Typography variant="caption">
          {asset.symbol} balance unavailable. Refresh to retry.
        </Typography>
      )}
      <AssetActions actions={actions} />
    </View>
  );
}
