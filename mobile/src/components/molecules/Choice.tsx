import { Text, useWindowDimensions } from "react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
export function Choice({
  label,
  selected,
  disabled = false,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  // Remeasure native text after Dynamic Type changes, including on inactive screens.
  // Remount only the text node so feature and navigation state are retained.
  const { fontScale } = useWindowDimensions();
  // Frontend filter pill: selected `bg-neon/10 text-neon`, otherwise `glass-soft text-white/45`.
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 max-w-full justify-center rounded-full border px-4 py-2.5 ${selected ? "border-neon/25 bg-neon/10" : "border-cardEdge bg-glassSoft"} ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        key={fontScale}
        className={`font-sans text-center text-[12px] leading-[18px] ${selected ? "text-neon" : "text-muted"}`}
        style={{ includeFontPadding: false }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}
