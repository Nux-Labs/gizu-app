import { useEffect, useId, useMemo, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { useScrollLock } from "@/components/templates/ScrollLock";
import { DitherFill } from "./DitherFill";
import { nearestIndex, plotSeries, smoothPath } from "./path";
import {
  chartColors,
  chartPad,
  chartStroke,
  crosshairDash,
  glowStroke,
  gridDash,
  gridLines,
  revealTiming,
  svgId,
} from "./tokens";

export type LineChartProps = {
  series: number[];
  height?: number;
  up?: boolean;
  /** Changing this replays the left-to-right reveal (e.g. the selected period). */
  revealKey?: string;
  /** Axis and scrub value text; defaults to two decimals. */
  format?: (value: number) => string;
};

const twoDecimals = (value: number) => value.toFixed(2);

const DOT = 9;
const RING = 4;
const HALO = DOT + RING * 2;

/**
 * Kurage chart: a cyan → violet glowing line over a dithered pixel fill, dashed grid,
 * left-to-right reveal, a pulsing live point and a touch scrub that lights the cells
 * around the finger.
 */
export function LineChart({
  series,
  height = 150,
  up = true,
  revealKey,
  format = twoDecimals,
}: LineChartProps) {
  const { fontScale } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const strokeId = svgId("chart-stroke", useId());
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const lockScroll = useScrollLock();
  const color = up ? chartColors.up : chartColors.down;
  const colorTo = up ? chartColors.upTo : chartColors.downTo;

  const { points, min, max, line } = useMemo(() => {
    const plot = plotSeries(series, width, height, chartPad);
    return { ...plot, line: smoothPath(plot.points) };
  }, [series, width, height]);

  const reveal = useSharedValue(reducedMotion ? 1 : 0);
  const measured = useSharedValue(0);
  const activeX = useSharedValue(0);
  const activeY = useSharedValue(0);
  const last = points[points.length - 1];

  const ready = width > 0;
  useEffect(() => {
    if (!ready) return;
    if (reducedMotion) {
      reveal.set(1);
      return;
    }
    reveal.set(0);
    reveal.set(withTiming(1, revealTiming));
  }, [revealKey, reducedMotion, reveal, ready]);

  useEffect(() => {
    if (!last) return;
    activeX.set(last.x);
    activeY.set(last.y);
  }, [last, activeX, activeY]);

  // Live point: a halo that breathes out and fades, like a heartbeat.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion) return;
    pulse.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), -1));
    return () => cancelAnimation(pulse);
  }, [pulse, reducedMotion]);
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - pulse.get()),
    transform: [{ scale: 1 + pulse.get() * 1.6 }],
  }));

  const revealStyle = useAnimatedStyle(() => ({ width: measured.get() * reveal.get() }));
  const crosshairStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: activeX.get() - 0.5 }],
  }));
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: activeX.get() - HALO / 2 }, { translateY: activeY.get() - HALO / 2 }],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    measured.set(next);
    setWidth(next);
  };
  const pick = (event: GestureResponderEvent) => {
    const index = nearestIndex(event.nativeEvent.locationX, width, points.length);
    const point = points[index];
    if (!point) return;
    activeX.set(point.x);
    activeY.set(point.y);
    setScrub((current) => (current === index ? current : index));
  };
  const grant = (event: GestureResponderEvent) => {
    lockScroll(true);
    pick(event);
  };
  const release = () => {
    lockScroll(false);
    if (last) {
      activeX.set(last.x);
      activeY.set(last.y);
    }
    setScrub(null);
  };

  const scrubValue = scrub === null ? undefined : points[scrub]?.v;
  const focusX = scrub === null ? null : (points[scrub]?.x ?? null);
  const label = "text-[10px] text-white/30";

  return (
    <View
      testID="line-chart"
      style={{ height }}
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={grant}
      onResponderMove={pick}
      onResponderRelease={release}
      onResponderTerminate={release}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {ready && (
        <View style={[StyleSheet.absoluteFill, styles.passThrough]}>
          <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
            {gridLines.map((g) => (
              <Line
                key={g}
                x1={0}
                x2={width}
                y1={height * g}
                y2={height * g}
                stroke={chartColors.grid}
                strokeDasharray={gridDash}
              />
            ))}
          </Svg>
          <Animated.View style={[styles.reveal, revealStyle]}>
            <View style={StyleSheet.absoluteFill}>
              <DitherFill
                points={points}
                width={width}
                height={height}
                from={color}
                to={colorTo}
                focusX={focusX}
                ground
              />
            </View>
            <Svg width={width} height={height}>
              <Defs>
                <LinearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0%" stopColor={color} />
                  <Stop offset="100%" stopColor={colorTo} />
                </LinearGradient>
              </Defs>
              <Path
                d={line}
                fill="none"
                stroke={`url(#${strokeId})`}
                strokeOpacity={0.18}
                strokeWidth={glowStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Path
                d={line}
                fill="none"
                stroke={`url(#${strokeId})`}
                strokeWidth={chartStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </Animated.View>
          <Animated.View style={[styles.crosshair, crosshairStyle]}>
            <Svg width={1} height={height}>
              <Line
                x1={0.5}
                x2={0.5}
                y1={0}
                y2={height}
                stroke={chartColors.crosshair}
                strokeDasharray={crosshairDash}
              />
            </Svg>
          </Animated.View>
          <Animated.View
            style={[styles.halo, { backgroundColor: `${colorTo}26` }, dotStyle]}
            testID="line-chart-dot"
          >
            <Animated.View
              style={[styles.pulse, { borderColor: colorTo }, pulseStyle]}
              pointerEvents="none"
            />
            <View style={[styles.dot, { backgroundColor: colorTo }]} />
          </Animated.View>
        </View>
      )}
      <View
        style={styles.passThrough}
        className="absolute inset-x-0 -top-1 flex-row justify-between pr-6"
      >
        <Text key={`min-${fontScale}`} className={`font-mono ${label}`} style={styles.nums}>
          {format(min)}
        </Text>
        {scrubValue !== undefined && (
          <Text
            key={`value-${fontScale}`}
            className="font-mono text-[10px] tracking-[1px]"
            style={[styles.nums, { color }]}
          >
            {format(scrubValue)}
          </Text>
        )}
        <Text key={`max-${fontScale}`} className={`font-mono ${label}`} style={styles.nums}>
          {format(max)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  passThrough: { pointerEvents: "none" },
  reveal: { position: "absolute", top: 0, bottom: 0, left: 0, overflow: "hidden" },
  crosshair: { position: "absolute", top: 0, left: 0 },
  halo: {
    position: "absolute",
    top: 0,
    left: 0,
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  pulse: {
    position: "absolute",
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    borderWidth: 1,
  },
  nums: { fontVariant: ["tabular-nums"] },
});
