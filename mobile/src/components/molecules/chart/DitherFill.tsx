import { useMemo } from "react";
import { Canvas, Picture, Skia, createPicture, type SkPaint } from "@shopify/react-native-skia";
import type { ChartPoint } from "./path";
import { ditherCells } from "./dither";

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Dithered pixel area under a chart line, coloured from `from` (left) to `to` (right). */
export function DitherFill({
  points,
  width,
  height,
  from,
  to,
  cell = 4,
  focusX = null,
  ground = false,
}: {
  points: ChartPoint[];
  width: number;
  height: number;
  from: string;
  to: string;
  cell?: number;
  focusX?: number | null;
  /** Faint empty cells across the whole plot, like a lit LED panel. */
  ground?: boolean;
}) {
  const picture = useMemo(
    () =>
      createPicture(
        (canvas) => {
          const a = hexRgb(from),
            b = hexRgb(to);
          const paints = new Map<string, SkPaint>();
          const paint = (color: string) => {
            let p = paints.get(color);
            if (!p) {
              p = Skia.Paint();
              p.setColor(Skia.Color(color));
              paints.set(color, p);
            }
            return p;
          };
          if (ground) {
            const dim = paint("rgba(255,255,255,0.025)");
            for (let x = 0; x < width; x += cell)
              for (let y = 0; y < height; y += cell)
                canvas.drawRect(Skia.XYWHRect(x + 1, y + 1, cell - 2, cell - 2), dim);
          }
          for (const c of ditherCells(points, width, height, cell, focusX)) {
            // Quantised colour keeps the paint cache small.
            const t = Math.round(c.t * 12) / 12;
            const rgb = a.map((v, i) => Math.round(v + (b[i]! - v) * t)).join(",");
            const inset = (cell - c.size) / 2;
            canvas.drawRect(
              Skia.XYWHRect(c.x + inset, c.y + inset, c.size, c.size),
              paint(`rgba(${rgb},${(Math.round(c.alpha * 10) / 10).toFixed(1)})`),
            );
          }
        },
        { width, height },
      ),
    [points, width, height, from, to, cell, focusX, ground],
  );
  return (
    <Canvas style={{ width, height }}>
      <Picture picture={picture} />
    </Canvas>
  );
}
