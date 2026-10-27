import { memo, useId } from "react";
import { StyleSheet } from "react-native";
import Svg, { Defs, Path, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";
import colors from "@/theme/colors.json";

/** Kurage page ground: a faint glyph-cell grid under cyan and violet glows. Static. */
export const Backdrop = memo(function Backdrop() {
  const id = useId().replace(/:/g, "");
  return (
    <Svg
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
    >
      <Defs>
        <Pattern id={`grid${id}`} width={10} height={15} patternUnits="userSpaceOnUse">
          <Path d="M10 0V15M0 15H10" stroke="rgba(255,255,255,0.028)" strokeWidth={1} />
        </Pattern>
        <RadialGradient id={`cyan${id}`} cx="12%" cy="0%" r="75%">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.11} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`violet${id}`} cx="100%" cy="8%" r="65%">
          <Stop offset="0" stopColor={colors.violet.DEFAULT} stopOpacity={0.09} />
          <Stop offset="1" stopColor={colors.violet.DEFAULT} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`fade${id}`} cx="50%" cy="40%" r="80%">
          <Stop offset="0.55" stopColor={colors.ink} stopOpacity={0} />
          <Stop offset="1" stopColor={colors.ink} stopOpacity={0.7} />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#grid${id})`} />
      <Rect width="100%" height="100%" fill={`url(#cyan${id})`} />
      <Rect width="100%" height="100%" fill={`url(#violet${id})`} />
      <Rect width="100%" height="100%" fill={`url(#fade${id})`} />
    </Svg>
  );
});
