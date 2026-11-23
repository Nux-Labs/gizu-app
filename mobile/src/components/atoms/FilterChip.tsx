import { Pressable, Text } from "react-native";
import { haptic } from "@/theme/haptics";

/**
 * A small chip for sorting (`radio`, one of a group) or filtering (`checkbox`, any number).
 * Selected chips get the accent outline; the rest stay a quiet hairline.
 */
export function FilterChip({
  label,
  selected,
  onPress,
  role = "radio",
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  role?: "radio" | "checkbox";
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      hitSlop={{ top: 4, bottom: 4 }}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      className={`min-h-7 justify-center rounded-full border px-2.5 ${
        selected ? "border-accent/50 bg-accent/10" : "border-glassBorder"
      }`}
    >
      <Text
        maxFontSizeMultiplier={1.3}
        className={`text-[12px] leading-4 ${selected ? "text-accent" : "text-fg-55"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
