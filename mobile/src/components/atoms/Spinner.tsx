import { useEffect, useId } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import colors from "@/theme/colors.json";

const sizes = { sm: 16, md: 24, lg: 36 } as const;

/**
 * Loaders ported from the portfolio spinner registry (framer-motion → Reanimated):
 * arc = GradientArc, twin = TwinOrbit, dual = DualArc, orbit = OrbitingDot,
 * wave = WaveDots, matrix = SpringDotMatrix, ring = the original track ring.
 */
export const spinnerVariants = ["arc", "twin", "dual", "orbit", "wave", "matrix", "ring"] as const;
export type SpinnerVariant = (typeof spinnerVariants)[number];
/** App-wide default; change this one value to switch every loader. */
export const defaultSpinner: SpinnerVariant = "arc";

const periods: Record<SpinnerVariant, number> = {
  arc: 1200,
  twin: 1500,
  dual: 1200,
  orbit: 1600,
  wave: 1000,
  matrix: 1500,
  ring: 800,
};

type Part = { t: SharedValue<number>; px: number; color: string };

function Rotor({
  t,
  px,
  children,
  reverse = false,
  pulse = false,
}: Part & {
  children: React.ReactNode;
  reverse?: boolean;
  pulse?: boolean;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${(reverse ? -1 : 1) * t.value * 360}deg` },
      { scale: pulse ? 1 - 0.18 * Math.sin(t.value * Math.PI) : 1 },
    ],
  }));
  return <Animated.View style={[{ width: px, height: px }, style]}>{children}</Animated.View>;
}

function GradientArc({ t, px, color }: Part) {
  const id = `spin-${useId().replace(/:/g, "")}`;
  const stroke = Math.max(2, px / 9);
  const r = (px - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <Rotor t={t} px={px} color={color}>
      <Svg width={px} height={px}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color} />
            <Stop offset="1" stopColor={colors.violet.DEFAULT} stopOpacity={0.15} />
          </LinearGradient>
        </Defs>
        <Circle
          cx={px / 2}
          cy={px / 2}
          r={r}
          stroke={`url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.72} ${c}`}
          fill="none"
        />
      </Svg>
    </Rotor>
  );
}

function ring(
  px: number,
  color: string,
  sides: ("Top" | "Right" | "Bottom" | "Left")[],
  track = "transparent",
) {
  const style: Record<string, string | number> = {
    width: px,
    height: px,
    borderRadius: px / 2,
    borderWidth: Math.max(1.5, Math.round(px / 12)),
    borderColor: track,
  };
  for (const side of sides) style[`border${side}Color`] = color;
  return style;
}

function TwinOrbit({ t, px, color }: Part) {
  const inner = px * 0.6;
  return (
    <View style={{ width: px, height: px }}>
      <Rotor t={t} px={px} color={color}>
        <View style={ring(px, color, ["Top", "Left"])} />
      </Rotor>
      <View className="absolute items-center justify-center" style={{ inset: 0 }}>
        <Rotor t={t} px={inner} color={color} reverse>
          <View style={ring(inner, colors.violet.DEFAULT, ["Bottom", "Right"])} />
        </Rotor>
      </View>
    </View>
  );
}

function DualArc({ t, px, color }: Part) {
  return (
    <Rotor t={t} px={px} color={color} pulse>
      <View style={ring(px, color, ["Top", "Bottom"])} />
    </Rotor>
  );
}

function OrbitingDot({ t, px, color }: Part) {
  const dot = Math.max(4, px / 4);
  return (
    <View className="items-center justify-center" style={{ width: px, height: px }}>
      <View
        style={{
          width: dot * 0.7,
          height: dot * 0.7,
          borderRadius: dot,
          backgroundColor: colors.violet.DEFAULT,
        }}
      />
      <View className="absolute" style={{ inset: 0 }}>
        <Rotor t={t} px={px} color={color}>
          <View
            style={[ring(px, `${color}33`, ["Top", "Right", "Bottom", "Left"]), { borderWidth: 1 }]}
          />
          <View
            className="absolute"
            style={{
              top: -dot / 2,
              left: px / 2 - dot / 2,
              width: dot,
              height: dot,
              borderRadius: dot,
              backgroundColor: color,
            }}
          />
        </Rotor>
      </View>
    </View>
  );
}

function WaveDot({ t, px, color, index }: Part & { index: number }) {
  const style = useAnimatedStyle(() => {
    const phase = (t.value - index * 0.15 + 1) % 1;
    return { transform: [{ translateY: Math.cos(phase * Math.PI * 2) * px * 0.18 }] };
  });
  const dot = Math.max(3, px / 4.5);
  return (
    <Animated.View
      style={[
        {
          width: dot,
          height: dot,
          borderRadius: dot,
          backgroundColor: index % 2 ? colors.violet.DEFAULT : color,
        },
        style,
      ]}
    />
  );
}

function WaveDots(part: Part) {
  return (
    <View className="flex-row items-center" style={{ height: part.px, gap: part.px / 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <WaveDot key={i} {...part} index={i} />
      ))}
    </View>
  );
}

function MatrixDot({ t, px, color, index }: Part & { index: number }) {
  const delay = (Math.floor(index / 3) + (index % 3)) * 0.1;
  const style = useAnimatedStyle(() => {
    const phase = (t.value - delay + 1) % 1;
    return { transform: [{ scale: 0.7 - 0.3 * Math.cos(phase * Math.PI * 2) }] };
  });
  const dot = px / 4;
  return (
    <Animated.View
      style={[
        {
          width: dot,
          height: dot,
          borderRadius: dot,
          backgroundColor: index % 2 ? colors.violet.DEFAULT : color,
        },
        style,
      ]}
    />
  );
}

function DotMatrix(part: Part) {
  const gap = part.px / 8;
  return (
    <View className="flex-row flex-wrap" style={{ width: part.px, height: part.px, gap }}>
      {Array.from({ length: 9 }, (_, i) => (
        <MatrixDot key={i} {...part} index={i} />
      ))}
    </View>
  );
}

function TrackRing({ t, px, color }: Part) {
  return (
    <Rotor t={t} px={px} color={color}>
      <View
        style={[
          ring(px, color, ["Top"], `${color}40`),
          { borderWidth: Math.max(2, Math.round(px / 10)) },
        ]}
      />
    </Rotor>
  );
}

const renderers: Record<SpinnerVariant, (part: Part) => React.JSX.Element> = {
  arc: GradientArc,
  twin: TwinOrbit,
  dual: DualArc,
  orbit: OrbitingDot,
  wave: WaveDots,
  matrix: DotMatrix,
  ring: TrackRing,
};

export function Spinner({
  size = "md",
  color = colors.neon.DEFAULT,
  variant = defaultSpinner,
  label,
}: {
  size?: keyof typeof sizes;
  color?: string;
  variant?: SpinnerVariant;
  /** Announced as a progress indicator; omit when the parent already reports busy state. */
  label?: string;
}) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    t.value = withRepeat(
      withTiming(1, { duration: periods[variant], easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(t);
  }, [t, reduced, variant]);
  const Render = renderers[variant];
  return (
    <View
      accessible={label !== undefined}
      accessibilityRole={label === undefined ? undefined : "progressbar"}
      accessibilityLabel={label}
      accessibilityElementsHidden={label === undefined}
      importantForAccessibility={label === undefined ? "no-hide-descendants" : "yes"}
    >
      <Render t={t} px={sizes[size]} color={color} />
    </View>
  );
}
