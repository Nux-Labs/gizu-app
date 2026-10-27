import { useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ChameleonField } from "@/components/molecules/chameleon/ChameleonField";
import colors from "@/theme/colors.json";

/**
 * Onboarding backdrop: the ASCII chameleon mascot on its branch (Kurage ocean
 * engine) under a `from-transparent via-ink/25 to-ink` scrim that keeps the copy readable.
 */
export function WelcomeBackdrop({ paused }: { paused: boolean }) {
  const id = `welcome-scrim-${useId().replace(/:/g, "")}`;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-0"
    >
      <ChameleonField anchorX={0.55} anchorY={0.3} size={0.24} paused={paused} />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.ink} stopOpacity={0} />
            <Stop offset="0.45" stopColor={colors.ink} stopOpacity={0.15} />
            <Stop offset="1" stopColor={colors.ink} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
