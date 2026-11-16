import type { ReactNode } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { PrimaryFill } from "./PrimaryFill";
import { haptic } from "@/theme/haptics";
import colors from "@/theme/colors.json";
import { PressableScale } from "./PressableScale";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "quiet" | "destructive" | "sell";
type Props = {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: Variant;
  icon?: ReactNode;
};

const surfaces: Record<Variant, string> = {
  primary: "bg-neon",
  sell: "bg-sell",
  secondary: "border border-cardEdge bg-well",
  destructive: "border border-glassBorder bg-glass",
  quiet: "",
};
const foregrounds: Record<Variant, string> = {
  primary: colors.ctaText,
  sell: colors.sellText,
  secondary: colors.text,
  destructive: colors.danger,
  quiet: colors.fg["70"],
};

export function Button({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
  icon,
}: Props) {
  // Remeasure native text after Dynamic Type changes, including on inactive screens.
  // Remount only the text node so feature and navigation state are retained.
  const { fontScale } = useWindowDimensions();
  const unavailable = disabled || loading;
  const quiet = variant === "quiet";
  const surface = disabled && !quiet ? "border border-borderSoft bg-glassSoft" : surfaces[variant];
  const foreground = disabled ? colors.muted : foregrounds[variant];
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: unavailable, busy: loading }}
      disabled={unavailable}
      onPress={() => {
        if (variant === "primary" || variant === "sell") haptic.tap();
        onPress();
      }}
      className={`relative items-center justify-center rounded-button ${quiet ? "min-h-11 px-2 py-2" : "min-h-14 px-5 py-4"} ${surface}`}
    >
      {variant === "primary" && !disabled && <PrimaryFill />}
      <View
        collapsable={false}
        pointerEvents="none"
        className="relative z-10 min-w-0 max-w-full flex-row items-center justify-center gap-3"
      >
        {loading ? <Spinner size="sm" color={foreground} /> : icon}
        <Text
          key={fontScale}
          className={`font-sans shrink text-center font-semibold ${quiet ? "text-[13px] leading-5" : "text-[15px] leading-[22px]"}`}
          style={{ color: foreground, includeFontPadding: false }}
        >
          {label}
        </Text>
      </View>
    </PressableScale>
  );
}
