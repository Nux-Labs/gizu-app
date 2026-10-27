import { Easing } from "react-native-reanimated";
import colors from "@/theme/colors.json";
import { reduceMotion } from "@/theme/motion";

// Frontend Chart.tsx / Sparkline.tsx values, kept in one place for both charts.
export const chartColors = {
  up: colors.neon.DEFAULT,
  /** Right-hand end of the gradient line and dither ramp. */
  upTo: colors.violet.DEFAULT,
  down: colors.sell,
  downTo: colors.rose,
  grid: "rgba(255,255,255,0.06)",
  crosshair: "rgba(255,255,255,0.22)",
} as const;

export const chartStroke = 2;
/** Soft glow under the line. */
export const glowStroke = 7;
export const gridLines = [0.25, 0.5, 0.75] as const;
export const gridDash = "2 6";
export const crosshairDash = "3 4";
/** Line chart inner padding (frontend: `(height - 18) - 9`). */
export const chartPad = 9;
/** Sparkline inner padding (frontend: `(height - 4) - 2`). */
export const sparkPad = 2;

/** Frontend reveal: `transition={{ duration: 1, ease: 'easeOut' }}` (framer easeOut). */
export const revealTiming = {
  duration: 1000,
  easing: Easing.bezier(0, 0, 0.58, 1),
  reduceMotion,
} as const;

/** SVG-safe unique id from React `useId` output. */
export function svgId(prefix: string, reactId: string): string {
  return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
