// Procedural ASCII chameleon: a signed-distance light field sampled once per glyph
// cell, then mapped to Kurage's tinted mosaic (glyph ramp on translucent tiles).
// Pure functions only; ChameleonField owns the Skia drawing and the frame loop.

export type RGB = readonly [number, number, number];
type Palette = { a: RGB; b: RGB };

/** Chameleons change colour: the body drifts through these pairs. */
export const PALETTES: readonly Palette[] = [
  { a: [92, 226, 240], b: [164, 140, 255] },
  { a: [98, 240, 170], b: [92, 194, 255] },
  { a: [168, 132, 255], b: [238, 140, 214] },
  { a: [252, 211, 77], b: [98, 240, 170] },
];
const PALETTE_HOLD = 7;
const PALETTE_BLEND = 1.6;

export const RAMP = [
  [".", ","],
  ["'", "`"],
  [":", "'"],
  [";", ":"],
  ["o", ";"],
  ["t", "o"],
  ["%", "t"],
  ["S", "%"],
  ["X", "S"],
  ["8", "X"],
  ["@", "8"],
  ["#", "@"],
] as const;
const ACCENTS = ["#f9a8d4", "#fcd34d", "#86efac", "#c4b5fd"];

export type Cell = { x: number; y: number; glyph: string; tile?: string; color: string };
export type Layout = {
  width: number;
  height: number;
  cw: number;
  ch: number;
  /** Body centre as a fraction of the canvas. */
  anchorX: number;
  anchorY: number;
  /** Pixels per body unit; the full chameleon is about 3.6 units wide. */
  scale: number;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function hash(x: number, y: number, t: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(t, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function paletteAt(time: number): Palette {
  const span = PALETTE_HOLD + PALETTE_BLEND;
  const index = Math.floor(time / span);
  const from = PALETTES[index % PALETTES.length]!;
  const to = PALETTES[(index + 1) % PALETTES.length]!;
  // Quantised blend keeps the style cache small (18 steps, like Kurage).
  const raw = clamp((time - index * span - PALETTE_HOLD) / PALETTE_BLEND, 0, 1);
  const t = ease(Math.round(raw * 18) / 18);
  const mix = (x: RGB, y: RGB) => x.map((v, i) => lerp(v, y[i]!, t)) as unknown as RGB;
  return { a: mix(from.a, to.a), b: mix(from.b, to.b) };
}

function ellipse(u: number, v: number, cx: number, cy: number, rx: number, ry: number) {
  return (Math.hypot((u - cx) / rx, (v - cy) / ry) - 1) * Math.min(rx, ry);
}
function capsule(u: number, v: number, ax: number, ay: number, bx: number, by: number) {
  const px = u - ax,
    py = v - ay,
    dx = bx - ax,
    dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return { d: Math.hypot(px - dx * h, py - dy * h), h };
}
function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Pose parameters for one moment; all motion is a pure function of time. */
export function pose(time: number) {
  const tongueCycle = (time % 6.5) / 6.5;
  const tongue =
    tongueCycle > 0.82 && tongueCycle < 0.92 ? Math.sin(((tongueCycle - 0.82) / 0.1) * Math.PI) : 0;
  const look = time * 0.7;
  return {
    bob: Math.sin(time * 1.3) * 0.025,
    breath: 1 + Math.sin(time * 1.1) * 0.03,
    sway: Math.sin(time * 0.25) * 0.15,
    turns: 1.12 + 0.22 * Math.sin(time * 0.5),
    pupilX: Math.cos(look) * 0.07,
    pupilY: Math.sin(look * 1.3) * 0.05,
    tongue: tongue * 2.1,
  };
}

type Pose = ReturnType<typeof pose>;
const TAIL_POINTS = 26;

function tailPath(p: Pose) {
  const cx = -1.5,
    cy = 0.45,
    r0 = 0.4;
  const points: { x: number; y: number; r: number }[] = [{ x: -0.85, y: 0.05, r: 0.17 }];
  for (let i = 0; i < TAIL_POINTS; i++) {
    const s = i / (TAIL_POINTS - 1);
    const angle = -Math.PI / 2 - s * p.turns * Math.PI * 2;
    const r = r0 * (1 - 0.78 * s);
    points.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      r: 0.15 * (1 - s * 0.7),
    });
  }
  return points;
}

/** Light at one point in body units: k = brightness, w = white core, m = hue A→B. */
export function sample(
  u: number,
  v: number,
  p: Pose,
  tail: ReturnType<typeof tailPath>,
  time: number,
) {
  const breath = p.breath;
  let body = ellipse(u, v, 0, -0.05, 1.0 * breath, 0.6 * breath);
  body = smin(body, ellipse(u, v, 1.0, -0.12, 0.5, 0.4), 0.14);
  body = smin(body, ellipse(u, v, 0.72, -0.42, 0.32, 0.26), 0.1);
  body = smin(body, Math.hypot(u - 1.38, v) - 0.2, 0.1);
  for (let i = 0; i < 9; i++) {
    const cu = -0.85 + i * 0.2;
    const cv = -0.05 - 0.6 * breath * Math.sqrt(Math.max(0, 1 - cu * cu)) - 0.02;
    body = Math.min(body, Math.hypot(u - cu, v - cv) - 0.065);
  }
  if (u < -0.6) {
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i]!,
        b = tail[i + 1]!;
      const seg = capsule(u, v, a.x, a.y, b.x, b.y);
      body = smin(body, seg.d - lerp(a.r, b.r, seg.h), 0.06);
    }
  }
  const legs = Math.min(
    capsule(u, v, 0.55, 0.35, 0.72, 0.86).d - 0.1,
    capsule(u, v, -0.5, 0.38, -0.68, 0.86).d - 0.1,
  );
  const farLegs = Math.min(
    capsule(u, v, 0.32, 0.4, 0.4, 0.86).d - 0.075,
    capsule(u, v, -0.78, 0.32, -0.92, 0.86).d - 0.075,
  );

  let k = 0,
    w = 0;
  const m = clamp(0.5 - u * 0.28 + 0.12 * Math.sin(v * 5 + time), 0, 1);
  if (body < 0) {
    const stripes = 0.8 + 0.2 * Math.sin(u * 7.5 - v * 3 + time * 0.8);
    k = (0.5 + 0.3 * Math.exp(body * 12)) * stripes;
    w = 0.06 + 0.12 * Math.exp(body * 16);
  } else k = 0.3 * Math.exp(-body * 25);

  if (legs < 0) k = Math.max(k, 0.5 + 0.2 * Math.exp(legs * 14));
  else if (farLegs < 0) k = Math.max(k, 0.3);

  // Turret eye: bright ring, lit iris, dark wandering pupil.
  const eyeX = 1.08,
    eyeY = -0.16;
  const eye = Math.hypot(u - eyeX, v - eyeY);
  if (Math.abs(eye - 0.19) < 0.04) {
    k = 0.85;
    w = 0.7;
  } else if (eye < 0.19) {
    const pupil = Math.hypot(u - eyeX - p.pupilX, v - eyeY - p.pupilY);
    k = pupil < 0.075 ? 0 : 0.55;
    w = 0.3;
  }

  // Mouth line and the occasional tongue strike.
  if (capsule(u, v, 1.05, 0.12, 1.55, 0.04).d < 0.03) k *= 0.25;
  if (p.tongue > 0.05) {
    const tipX = 1.55 + p.tongue,
      tipY = 0.04 - p.tongue * 0.05;
    const tongue = Math.min(
      capsule(u, v, 1.5, 0.04, tipX, tipY).d - 0.035,
      Math.hypot(u - tipX, v - tipY) - 0.085,
    );
    if (tongue < 0) {
      k = 0.95;
      w = 0.5;
    }
  }

  // Branch the chameleon grips, with a few leaves.
  const branch = Math.abs(v - 0.92 - 0.04 * Math.sin(u * 1.3)) - 0.05;
  if (branch < 0 && k < 0.3) {
    k = 0.3;
    w = 0;
  }
  for (const [lu, lv] of [
    [-2.1, 0.78],
    [1.9, 0.8],
    [2.5, 1.02],
  ] as const) {
    if (ellipse(u, v, lu, lv, 0.22, 0.09) < 0 && k < 0.36) k = 0.36;
  }
  return { k, w, m };
}

type Style = { tile: string; glyph: string; hot: boolean };

export function createStyler() {
  const cache = new Map<number, Style>();
  let current = "";
  return (palette: Palette, tb: number, lv: number, wb: number): Style => {
    const id = `${palette.a.join()}|${palette.b.join()}`;
    if (id !== current) {
      cache.clear();
      current = id;
    }
    const key = (tb * 12 + lv) * 3 + wb;
    const hit = cache.get(key);
    if (hit) return hit;
    // Kurage style(): tinted tile under every lit glyph; the hottest cells invert.
    const t = tb / 5,
      L = (lv + 0.5) / 12,
      w = [0, 0.3, 0.62][wb]!;
    const base = [0, 1, 2].map((i) => lerp(palette.a[i]!, palette.b[i]!, t));
    const hot = lv >= 10 && wb > 0;
    const tileMix = hot ? 0.5 + w * 0.3 : 0;
    const tile = base.map((v) => lerp(v * 0.58, 236, tileMix) | 0);
    const mixW = clamp(0.12 + L * 0.5 + w * 0.34, 0, 0.94);
    const glyph = hot ? [6, 10, 16] : base.map((v) => lerp(v, 246, mixW) | 0);
    const style = {
      hot,
      tile: `rgba(${tile.join(",")},${(hot ? 0.9 : 0.1 + L * 0.5).toFixed(3)})`,
      glyph: hot
        ? `rgb(${glyph.join(",")})`
        : `rgba(${glyph.join(",")},${(0.4 + L * 0.6).toFixed(3)})`,
    };
    cache.set(key, style);
    return style;
  };
}

/** Lit cells of one frame. `styler` comes from createStyler and is reused across frames. */
export function frame(layout: Layout, time: number, styler: ReturnType<typeof createStyler>) {
  const { width, height, cw, ch, scale } = layout;
  const p = pose(time);
  const tail = tailPath(p);
  const palette = paletteAt(time);
  const cx = width * layout.anchorX + p.sway * scale;
  const cy = height * layout.anchorY;
  // Only cells near the body, tongue and branch can light up.
  const top = Math.max(0, Math.floor((cy - scale * 1.0) / ch));
  const bottom = Math.min(Math.ceil(height / ch), Math.ceil((cy + scale * 1.15) / ch));
  const cols = Math.ceil(width / cw);
  const cells: Cell[] = [];
  const tickRate = 1.4;
  for (let row = top; row < bottom; row++) {
    for (let col = 0; col < cols; col++) {
      const px = col * cw + cw / 2,
        py = row * ch + ch / 2;
      const s = sample((px - cx) / scale, (py - cy) / scale - p.bob, p, tail, time);
      const L = Math.min(1, s.k + s.w * 0.55);
      if (L < 0.055) continue;
      const tb = Math.round(s.m * 5);
      const lv = Math.min(11, (L * 12) | 0);
      const wb = s.w < 0.12 ? 0 : s.w < 0.32 ? 1 : 2;
      const style = styler(palette, tb, lv, wb);
      const tick = Math.floor(time * tickRate + ((col * 7 + row * 13) & 15) / 16);
      const h = hash(col, row, tick);
      cells.push({
        x: col * cw,
        y: row * ch,
        tile: lv >= 1 ? style.tile : undefined,
        glyph: RAMP[lv]![h < 0.55 ? 0 : 1],
        color: lv >= 4 && lv < 10 && h > 0.986 ? ACCENTS[((h * 1e4) | 0) & 3]! : style.glyph,
      });
    }
  }
  return cells;
}
