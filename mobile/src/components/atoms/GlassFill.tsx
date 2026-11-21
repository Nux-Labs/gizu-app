import { useId, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import colors from "@/theme/colors.json";

/**
 * Frosted-glass pill fill, stretched to its parent: a faint cyan → violet tint, a top sheen and
 * a light-catching edge that fades downward. Drawn in SVG (no native blur) and rounded to half
 * its measured height, so the parent needs no overflow clipping (which hides labels on Android).
 * Give the parent's content `relative z-10` so it sits above the fill.
 */
export function GlassFill() {
  const id = `glass-${useId().replace(/:/g, "")}`;
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const radius = size ? size.height / 2 : 0;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
      onLayout={({ nativeEvent: { layout } }) =>
        setSize((current) =>
          current?.width === layout.width && current.height === layout.height
            ? current
            : { width: layout.width, height: layout.height },
        )
      }
    >
      {size && size.width > 1 && size.height > 1 ? (
        <Svg width={size.width} height={size.height}>
          <Defs>
            <LinearGradient id={`${id}-tint`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={colors.cyanSoft} stopOpacity={0.16} />
              <Stop offset="1" stopColor={colors.violet.soft} stopOpacity={0.07} />
            </LinearGradient>
            <LinearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.16} />
              <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.03} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
            <LinearGradient id={`${id}-edge`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.42} />
              <Stop offset="0.6" stopColor="#ffffff" stopOpacity={0.1} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity={0.05} />
            </LinearGradient>
          </Defs>
          <Rect
            width={size.width}
            height={size.height}
            rx={radius}
            ry={radius}
            fill={`url(#${id}-tint)`}
          />
          <Rect
            width={size.width}
            height={size.height}
            rx={radius}
            ry={radius}
            fill={`url(#${id}-sheen)`}
          />
          <Rect
            x={0.5}
            y={0.5}
            width={size.width - 1}
            height={size.height - 1}
            rx={radius - 0.5}
            ry={radius - 0.5}
            fill="none"
            stroke={`url(#${id}-edge)`}
            strokeWidth={1}
          />
        </Svg>
      ) : null}
    </View>
  );
}
