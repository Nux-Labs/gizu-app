import { Pressable, ScrollView, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import colors from "@/theme/colors.json";
import { haptic } from "@/theme/haptics";

/**
 * Text tabs over a hairline, the selected one marked with the rail's short cyan → violet bar.
 * For switching between sections of one screen.
 */
export function UnderlineTabs<K extends string>({
  tabs,
  selected,
  onSelect,
}: {
  tabs: readonly { key: K; label: string }[];
  selected: K;
  onSelect: (key: K) => void;
}) {
  return (
    <View accessibilityRole="tablist" className="border-b border-glassBorder">
      {/* Scrolls sideways only when the labels outgrow a narrow screen or large text. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        {tabs.map((tab) => {
          const active = tab.key === selected;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: active }}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => {
                if (active) return;
                haptic.select();
                onSelect(tab.key);
              }}
              className="mr-6 items-center pb-2.5 pt-1"
            >
              <Text
                maxFontSizeMultiplier={1.4}
                className={`text-[15px] leading-5 ${active ? "font-medium text-text" : "text-fg-45"}`}
              >
                {tab.label}
              </Text>
              <View className="absolute bottom-0 h-[2px] w-5">
                {active && (
                  <Svg width={20} height={2}>
                    <Defs>
                      <LinearGradient id="underline-tab" x1="0" y1="0" x2="1" y2="0">
                        <Stop offset="0" stopColor={colors.accent} />
                        <Stop offset="1" stopColor={colors.violet.DEFAULT} />
                      </LinearGradient>
                    </Defs>
                    <Rect width={20} height={2} rx={1} fill="url(#underline-tab)" />
                  </Svg>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
