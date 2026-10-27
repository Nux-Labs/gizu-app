import { curveAt, ditherCells } from "@/components/molecules/chart/dither";
import { plotSeries } from "@/components/molecules/chart/path";

const { points } = plotSeries([1, 4, 2, 5], 120, 60, 4);
const below = (c: { x: number; y: number }) => c.y + 2 - curveAt(points, 120, c.x + 2);

test("dither stays under the curve and thins with depth", () => {
  const cells = ditherCells(points, 120, 60, 4);
  expect(cells.length).toBeGreaterThan(50);
  for (const c of cells) expect(below(c)).toBeGreaterThanOrEqual(-2); // edge cells straddle the line
  const band = (lo: number, hi: number) =>
    cells.filter((c) => below(c) >= lo && below(c) < hi).length;
  expect(band(30, 45)).toBeLessThan(band(6, 21));
});

test("scrub focus swells nearby fill cells and empty input draws nothing", () => {
  const base = ditherCells(points, 120, 60, 4).find((c) => c.x === 60 && c.size < 3)!;
  const focused = ditherCells(points, 120, 60, 4, 60).find((c) => c.x === 60 && c.y === base.y)!;
  expect(focused.size).toBeGreaterThan(base.size);
  expect(ditherCells(points.slice(0, 1), 120, 60, 4)).toEqual([]);
});
