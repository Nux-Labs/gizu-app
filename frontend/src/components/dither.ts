// Shared with mobile/src/components/molecules/chart/dither.ts; keep the two in sync.
export type ChartPoint = { x: number; y: number };

// 4×4 Bayer matrix: ordered-dither thresholds, so the fill fades by pixel density
// (Kurage mosaic / portfolio DitherGrowthChart) instead of a smooth alpha ramp.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export type DitherCell = { x: number; y: number; size: number; alpha: number; t: number };

/** Curve height at x, interpolated between evenly spaced points. */
export function curveAt(points: ChartPoint[], width: number, x: number): number {
  if (points.length === 1 || width <= 0) return points[0]?.y ?? 0;
  const exact = (Math.min(width, Math.max(0, x)) / width) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(exact));
  const f = exact - i;
  return points[i]!.y + (points[i + 1]!.y - points[i]!.y) * f;
}

/**
 * Cells lit under the curve. Brightest along the line, thinning toward the baseline;
 * `focusX` swells the cells around a scrub position. `t` is the 0–1 horizontal
 * position for the colour ramp.
 */
export function ditherCells(
  points: ChartPoint[],
  width: number,
  height: number,
  cell: number,
  focusX: number | null = null,
): DitherCell[] {
  if (points.length < 2 || width <= 0 || height <= 0) return [];
  const cells: DitherCell[] = [];
  const depth = height * 0.85;
  for (let col = 0; col * cell < width; col++) {
    const x = col * cell;
    const top = curveAt(points, width, x + cell / 2);
    const focus = focusX === null ? 0 : Math.max(0, 1 - Math.abs(x - focusX) / (width * 0.18));
    for (let row = Math.floor(top / cell); row * cell < height; row++) {
      const y = row * cell;
      const fade = 1 - (y + cell / 2 - top) / depth;
      if (fade <= 0) break;
      const edge = y + cell / 2 - top < cell * 1.5;
      if (!edge && fade < (BAYER[(col % 4) + (row % 4) * 4]! + 0.5) / 16) continue;
      cells.push({
        x,
        y,
        size: cell * (edge ? 0.8 : 0.62 + focus * 0.25),
        alpha: edge ? 0.85 : Math.min(0.85, 0.22 + fade * 0.45 + focus * 0.3),
        t: x / width,
      });
    }
  }
  return cells;
}
