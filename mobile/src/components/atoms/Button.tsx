import { Text, useWindowDimensions } from "react-native";
import { PrimaryFill } from "./PrimaryFill";
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
};

const surfaces: Record<Variant, string> = {
  primary: "overflow-hidden bg-neon",
  sell: "bg-sell",
  secondary: "border border-cardEdge bg-well",
  destructive: "border border-glassBorder bg-glass",
  quiet: "",
};
const foregrounds: Record<Variant, string> = {
  primary: "text-ctaText",
  sell: "text-sellText",
  secondary: "text-text",
  destructive: "text-danger",
  quiet: "text-fg-70",
};
const spinners: Record<Variant, string> = {
  primary: colors.ctaText,
  sell: colors.sellText,
  secondary: colors.accent,
  destructive: colors.danger,
  quiet: colors.accent,
};

export function Button({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
}: Props) {
  // Remeasure native text after Dynamic Type changes, including on inactive screens.
  // Remount only the text node so feature and navigation state are retained.
  const { fontScale } = useWindowDimensions();
  const unavailable = disabled || loading;
  const quiet = variant === "quiet";
  const surface = disabled && !quiet ? "border border-borderSoft bg-glassSoft" : surfaces[variant];
  const foreground = disabled ? "text-fg-35" : foregrounds[variant];
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: unavailable, busy: loading }}
      disabled={unavailable}
      onPress={onPress}
      className={`flex-row items-center justify-center gap-3 rounded-button ${quiet ? "min-h-11 px-2 py-2" : "min-h-14 px-5 py-4"} ${surface}`}
    >
      {variant === "primary" && !disabled && <PrimaryFill />}
      {loading && <Spinner size="sm" color={spinners[variant]} />}
      <Text
        key={fontScale}
        className={`font-sans shrink text-center font-semibold ${quiet ? "text-[13px]" : "text-[15px]"} ${foreground}`}
      >
        {label}
      </Text>
    </PressableScale>
  );
}
