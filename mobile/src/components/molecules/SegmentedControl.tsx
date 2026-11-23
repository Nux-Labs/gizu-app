import { Pressable, Text, View } from "react-native";
import { haptic } from "@/theme/haptics";

/** A compact two- or three-way switch for a secondary choice, such as a list's scope. */
export function SegmentedControl<K extends string>({
  options,
  selected,
  onSelect,
}: {
  options: readonly { key: K; label: string }[];
  selected: K;
  onSelect: (key: K) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row self-start rounded-xl border border-glassBorder bg-well p-0.5"
    >
      {options.map((option) => {
        const active = option.key === selected;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) return;
              haptic.select();
              onSelect(option.key);
            }}
            className={`min-h-8 justify-center rounded-[10px] px-3 ${active ? "bg-white/[0.09]" : ""}`}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              className={`text-[12px] leading-4 ${active ? "font-medium text-text" : "text-fg-45"}`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
