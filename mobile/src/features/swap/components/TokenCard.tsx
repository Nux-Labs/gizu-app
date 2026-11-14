import { useState } from "react";
import { Image, View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { tokenDisplayName, tokenNetworks, type CatalogToken } from "@/domain/tokenCatalog";
import { RobinhoodChainMark } from "./RobinhoodChainMark";
import { formatUsd } from "../formatUsd";
function TokenLogo({ token }: { token: CatalogToken }) {
  const [failed, setFailed] = useState(false);
  return token.logoURI && /^https?:\/\//i.test(token.logoURI) && !failed ? (
    <Image
      source={{ uri: token.logoURI }}
      accessibilityLabel={`${token.symbol} logo`}
      className="h-11 w-11 rounded-full"
      onError={() => setFailed(true)}
    />
  ) : (
    <View
      accessibilityLabel={`${token.symbol} logo unavailable`}
      className="h-11 w-11 items-center justify-center rounded-full bg-neon/10"
    >
      <Typography variant="label">{token.symbol.slice(0, 2).toUpperCase() || "?"}</Typography>
    </View>
  );
}
export function TokenCard({ token }: { token: CatalogToken }) {
  const price =
    typeof token.priceUsd === "number" && Number.isFinite(token.priceUsd)
      ? formatUsd(token.priceUsd)
      : null;
  return (
    <View className="flex-1 gap-4 rounded-card border border-cardEdge bg-card p-4">
      <View className="flex-row items-center justify-between gap-2">
        <TokenLogo key={token.logoURI} token={token} />
        {token.chainId === 4663 ? (
          <RobinhoodChainMark />
        ) : (
          <Typography variant="micro">
            {tokenNetworks.find((n) => n.chainId === token.chainId)?.name}
          </Typography>
        )}
      </View>
      <View className="gap-1">
        <Typography variant="value" numberOfLines={1}>
          {token.symbol}
        </Typography>
        <Typography variant="caption" numberOfLines={2} className="min-h-10 !text-fg-55">
          {tokenDisplayName(token.name)}
        </Typography>
      </View>
      <View className="gap-1">
        <Typography variant="label11">USD price</Typography>
        <Typography
          variant="rowTitle"
          className="!text-[20px]"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {price ?? "Unavailable"}
        </Typography>
      </View>
      <View className="mt-auto gap-2 border-t border-cardEdge pt-3">
        <View className="self-start rounded-full bg-neon/10 px-2.5 py-1">
          <Typography variant="micro" className="!text-neon">
            {token.category === "rwa" ? "RWA" : "Other asset"}
          </Typography>
        </View>
        {token.issuer && <Typography variant="micro">Issuer: {token.issuer}</Typography>}
        <Typography variant="micro">
          {token.swapListed ? "Listed on 1inch" : "Not listed on 1inch"}
        </Typography>
      </View>
    </View>
  );
}
