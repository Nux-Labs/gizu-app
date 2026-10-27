import { useId, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Typography } from "@/components/atoms/Typography";
import { ChameleonField } from "@/components/molecules/chameleon/ChameleonField";
import colors from "@/theme/colors.json";

/**
 * Screen-top hero in the Kurage layout: the ASCII chameleon on its branch and a
 * light page title. Bleeds to the edges of the Screen padding.
 */
export function MascotHero({
  title,
  leading,
  trailing,
}: {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const id = `hero-${useId().replace(/:/g, "")}`;
  return (
    <View className="-mx-5 -mt-4 h-[200px] overflow-hidden">
      <ChameleonField anchorX={0.64} anchorY={0.42} size={0.13} grid={false} />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.5" stopColor={colors.ink} stopOpacity={0} />
            <Stop offset="0.8" stopColor={colors.ink} stopOpacity={0.55} />
            <Stop offset="1" stopColor={colors.ink} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
      <View className="flex-1 justify-between px-5 pb-1 pt-4">
        <View className="flex-row items-center justify-between gap-3">
          {leading ?? <View />}
          {trailing}
        </View>
        <Typography variant="pageTitle" accessibilityRole="header">
          {title}
        </Typography>
      </View>
    </View>
  );
}
