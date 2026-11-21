import { View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { GlassFill } from "@/components/atoms/GlassFill";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import colors from "@/theme/colors.json";
import { TokenAvatar, type TokenLogo } from "./TokenAvatar";

const pill = "min-h-11 flex-row items-center rounded-full";

/**
 * Glass token chip on a swap amount row: logo and ticker, no company name (the token list and
 * detail page carry it). With `onPress` it opens a token choice and shows a chevron; without it,
 * it only labels the row's fixed token. Omit `logo` when no token is chosen yet.
 */
export function TokenPill({
  symbol,
  logo,
  onPress,
  accessibilityLabel,
  disabled = false,
  expanded,
  className = "",
}: {
  symbol: string;
  logo?: TokenLogo;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  expanded?: boolean;
  className?: string;
}) {
  const content = (
    <View
      className={`relative z-10 flex-row items-center gap-2 py-2 pr-3.5 ${logo ? "pl-1.5" : "pl-3.5"}`}
    >
      {logo ? <TokenAvatar symbol={symbol} logo={logo} /> : null}
      <Typography variant="rowTitle" numberOfLines={1} className="shrink !text-text">
        {symbol}
      </Typography>
      {onPress ? <ChevronDown size={14} color={colors.fg["70"]} /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View className={`${pill} ${className}`}>
        <GlassFill />
        {content}
      </View>
    );
  }
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      className={`${pill} ${disabled ? "opacity-50" : ""} ${className}`}
    >
      <GlassFill />
      {content}
    </PressableScale>
  );
}
