import { useId, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { DitherFill } from "@/components/molecules/chart/DitherFill";
import { plotSeries, smoothPath } from "@/components/molecules/chart/path";
import { chartColors, chartStroke, sparkPad, svgId } from "@/components/molecules/chart/tokens";

/** Card sparkline: gradient line over a fine dithered fill, sized to its container. */
export function Sparkline({
  series,
  negative = false,
  height = 48,
}: {
  series: number[];
  negative?: boolean;
  height?: number;
}) {
  const strokeId = svgId(negative ? "spark-down" : "spark-up", useId());
  const [width, setWidth] = useState(0);
  const plot = useMemo(() => {
    if (series.length < 2 || width <= 0) return null;
    const { points } = plotSeries(series, width, height, sparkPad);
    return { points, line: smoothPath(points) };
  }, [series, width, height]);
  if (series.length < 2) return null;
  const from = negative ? chartColors.down : chartColors.up;
  const to = negative ? chartColors.downTo : chartColors.upTo;
  return (
    <View
      testID="sparkline"
      style={{ height }}
      onLayout={({ nativeEvent }) => setWidth(Math.round(nativeEvent.layout.width))}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {plot && (
        <>
          <View style={StyleSheet.absoluteFill}>
            <DitherFill
              points={plot.points}
              width={width}
              height={height}
              from={from}
              to={to}
              cell={3}
            />
          </View>
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0%" stopColor={from} />
                <Stop offset="100%" stopColor={to} />
              </LinearGradient>
            </Defs>
            <Path
              d={plot.line}
              fill="none"
              stroke={`url(#${strokeId})`}
              strokeWidth={chartStroke * 0.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </>
      )}
    </View>
  );
}
