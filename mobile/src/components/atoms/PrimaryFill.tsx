import { useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import colors from "@/theme/colors.json";
import radii from "@/theme/radii.json";

// The gradient rounds its own corners: overflow hidden on the button hides its label on Android.
const radius = parseFloat(radii.button);

/** Kurage ready-state fill: cyan-200 → violet-200 at 135°, stretched to its parent. */
export function PrimaryFill() {
  const gradientId = `button-primary-${useId().replace(/:/g, "")}`;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colors.cyanSoft} />
            <Stop offset="1" stopColor={colors.violet.soft} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" rx={radius} ry={radius} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}
