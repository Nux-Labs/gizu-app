import { useContext, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import {
  Canvas,
  Picture,
  Skia,
  createPicture,
  matchFont,
  type SkCanvas,
  type SkPaint,
} from "@shopify/react-native-skia";
import { useReducedMotion, useSharedValue } from "react-native-reanimated";
import { NavigationContext } from "@react-navigation/native";
import { monoFamily } from "@/theme/fonts";
import { createStyler, frame, type Layout } from "./field";

const FRAME_MS = 1000 / 20;
const DUST = [".", ".", ".", "-", "-", "'", ",", "·"];
type Dust = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  seed: number;
  glyph: string;
  color: string;
};

/** Animates only while its screen is focused, the app is foregrounded and motion is allowed. */
function useActive(paused: boolean) {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    if (!navigation) return;
    const offFocus = navigation.addListener("focus", () => setFocused(true));
    const offBlur = navigation.addListener("blur", () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => sub.remove();
  }, []);
  return !paused && focused && foreground;
}

function seedDust(width: number, height: number, cw: number, ch: number): Dust[] {
  const count = Math.round(((width / cw) * (height / ch)) / 90);
  return Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vy: 3 + Math.random() * 8,
    vx: (Math.random() - 0.5) * 3,
    seed: Math.random() * 6.28,
    glyph: DUST[(Math.random() * DUST.length) | 0]!,
    color: `rgba(150,172,205,${(0.14 + Math.random() * 0.3).toFixed(3)})`,
  }));
}

/**
 * Gizu's mascot as a live ASCII mosaic (the Kurage jellyfish engine, re-rigged as a
 * chameleon): a grid of monospace glyphs on tinted tiles, drifting dust and a faint
 * cell grid. Decorative; hidden from assistive technology.
 */
export function ChameleonField({
  anchorX = 0.5,
  anchorY = 0.45,
  size = 0.2,
  grid = true,
  paused = false,
}: {
  anchorX?: number;
  anchorY?: number;
  /** Body unit as a fraction of the canvas width (capped by height). */
  size?: number;
  grid?: boolean;
  paused?: boolean;
}) {
  const reduced = useReducedMotion();
  const active = useActive(paused || reduced);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const picture = useSharedValue(createPicture(() => undefined));
  const state = useRef({ time: 4, dust: [] as Dust[], styler: createStyler() });

  useEffect(() => {
    const { width, height } = box;
    if (!width || !height) return;
    const cw = width < 600 ? 8 : 9;
    const ch = Math.round(cw * 1.5);
    const fontSize = Math.round(ch * 0.74);
    const font = matchFont({ fontFamily: monoFamily, fontSize, fontWeight: "500" });
    const glyphWidth = font.getTextWidth("M");
    const paints = new Map<string, SkPaint>();
    const paint = (color: string) => {
      let p = paints.get(color);
      if (!p) {
        // ponytail: palette blends mint new colours; a flush beats an LRU here.
        if (paints.size > 4000) paints.clear();
        p = Skia.Paint();
        p.setAntiAlias(true);
        p.setColor(Skia.Color(color));
        paints.set(color, p);
      }
      return p;
    };
    const layout: Layout = {
      width,
      height,
      cw,
      ch,
      anchorX,
      anchorY,
      scale: Math.min(width * size, height * 0.32),
    };
    const s = state.current;
    s.dust = seedDust(width, height, cw, ch);
    const baseline = ch / 2 + fontSize * 0.35;
    const offset = (cw - glyphWidth) / 2;

    const draw = (canvas: SkCanvas) => {
      if (grid) {
        const line = paint("rgba(255,255,255,0.03)");
        for (let x = cw; x < width; x += cw) canvas.drawLine(x, 0, x, height, line);
        for (let y = ch; y < height; y += ch) canvas.drawLine(0, y, width, y, line);
      }
      for (const d of s.dust)
        canvas.drawText(
          d.glyph,
          Math.floor(d.x / cw) * cw + offset,
          Math.floor(d.y / ch) * ch + baseline,
          paint(d.color),
          font,
        );
      for (const cell of frame(layout, s.time, s.styler)) {
        if (cell.tile)
          canvas.drawRect(Skia.XYWHRect(cell.x + 1, cell.y + 1, cw - 2, ch - 2), paint(cell.tile));
        canvas.drawText(cell.glyph, cell.x + offset, cell.y + baseline, paint(cell.color), font);
      }
    };
    const render = () => {
      // The UI thread may still be drawing the previous picture; GC frees it.
      picture.value = createPicture(draw, { width, height });
    };
    const step = (dt: number) => {
      s.time += dt;
      for (const d of s.dust) {
        d.y += d.vy * dt;
        d.x += (d.vx + Math.sin(s.time * 0.3 + d.seed) * 2) * dt;
        if (d.y > height + ch) {
          d.y = -ch;
          d.x = Math.random() * width;
        }
      }
    };

    render();
    if (!active) return;
    let last = 0;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!last) last = now;
      if (now - last < FRAME_MS) return;
      step(Math.min(0.1, (now - last) / 1000));
      last = now;
      render();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [box, active, anchorX, anchorY, size, grid, picture]);

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      onLayout={({ nativeEvent }) =>
        setBox({
          width: Math.round(nativeEvent.layout.width),
          height: Math.round(nativeEvent.layout.height),
        })
      }
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}
