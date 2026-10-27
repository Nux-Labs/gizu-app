import { Text, View, useWindowDimensions } from "react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
import { haptic } from "@/theme/haptics";

// Visual pills are small (frontend `px-3 py-1.5`); hitSlop keeps a comfortable touch target.
const hitSlop = { top: 10, bottom: 10, left: 4, right: 4 };

/** Frontend chart period pills: selected `bg-neon/15 text-neon`, otherwise `text-white/30`. */
export function PeriodPills<T extends string>({
  options,
  selected,
  onSelect,
  label = "Chart period",
}: {
  options: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  label?: string;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <View
      className="flex-row flex-wrap gap-2"
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {options.map((value) => {
        const checked = value === selected;
        return (
          <PressableScale
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={value}
            accessibilityState={{ checked }}
            hitSlop={hitSlop}
            onPress={() => {
              if (value !== selected) haptic.select();
              onSelect(value);
            }}
            className={`rounded-full px-3 py-1.5 ${checked ? "bg-neon/15" : ""}`}
          >
            <Text
              key={fontScale}
              className={`font-sans text-[12px] font-medium ${checked ? "text-neon" : "text-white/30"}`}
            >
              {value}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
