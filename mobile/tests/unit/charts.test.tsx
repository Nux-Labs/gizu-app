import { fireEvent, render, screen, userEvent } from "@testing-library/react-native";
import { areaPath, nearestIndex, plotSeries, smoothPath } from "@/components/molecules/chart/path";
import { LineChart } from "@/components/molecules/chart/LineChart";
import { Sparkline } from "@/components/molecules/Sparkline";
import { HistoryChart } from "@/components/organisms/HistoryChart";

const hidden = { includeHiddenElements: true };

test("plots the highest value at the top and keeps flat series finite", () => {
  const { points, min, max } = plotSeries([1, 3, 2], 100, 50, 9);
  expect([min, max]).toEqual([1, 3]);
  expect(points.map((p) => p.x)).toEqual([0, 50, 100]);
  expect(points[1]!.y).toBe(9);
  expect(points[0]!.y).toBe(41);
  const flat = plotSeries([5, 5], 100, 50, 2).points;
  expect(flat.every((p) => Number.isFinite(p.y))).toBe(true);
});

test("builds one bezier segment per step and closes the fill at the baseline", () => {
  const line = smoothPath(plotSeries([1, 2, 3, 2], 90, 30, 2).points);
  expect(line.startsWith("M0.00,")).toBe(true);
  expect(line.match(/ C/g)).toHaveLength(3);
  expect(areaPath(line, 90, 30).endsWith("L90,30 L0,30 Z")).toBe(true);
});

test("snaps a touch position to the nearest sample", () => {
  expect(nearestIndex(-20, 300, 4)).toBe(0);
  expect(nearestIndex(160, 300, 4)).toBe(2);
  expect(nearestIndex(999, 300, 4)).toBe(3);
  expect(nearestIndex(10, 0, 4)).toBe(3);
});

test("scrubbing shows the touched value and releasing clears it", () => {
  render(<LineChart series={[10, 20, 30, 40]} height={120} />);
  const chart = screen.getByTestId("line-chart", hidden);
  fireEvent(chart, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 120 } } });
  expect(screen.getByText("10.00", hidden)).toBeTruthy();
  expect(screen.getByText("40.00", hidden)).toBeTruthy();
  fireEvent(chart, "responderGrant", { nativeEvent: { locationX: 110 } });
  expect(screen.getByText("20.00", hidden)).toBeTruthy();
  fireEvent(chart, "responderMove", { nativeEvent: { locationX: 190 } });
  expect(screen.getByText("30.00", hidden)).toBeTruthy();
  fireEvent(chart, "responderRelease");
  expect(screen.queryByText("30.00", hidden)).toBeNull();
});

test("period pills keep radio semantics and update the accessible summary", async () => {
  const series = Array.from({ length: 60 }, (_, i) => 100 + i);
  render(<HistoryChart series={series} />);
  expect(screen.getByRole("radio", { name: "1M" })).toBeChecked();
  expect(screen.getByLabelText(/1M index:.*32 samples/)).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "1Y" }));
  expect(screen.getByRole("radio", { name: "1Y" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "1M" })).not.toBeChecked();
  expect(screen.getByLabelText(/1Y index:.*48 samples/)).toBeVisible();
});

test("history chart draws a flat zero line without enough samples", () => {
  render(<HistoryChart series={[1]} />);
  expect(screen.getByLabelText("1M index: no history")).toBeVisible();
  expect(screen.queryByText("No chart history available.")).toBeNull();
  expect(screen.getByRole("radio", { name: "1D" })).toBeVisible();
});

test("sparkline renders nothing for a single sample", () => {
  const { toJSON } = render(<Sparkline series={[1]} />);
  expect(toJSON()).toBeNull();
});

test("scrubbing shows the sample's label and the axis shows the range", () => {
  render(<LineChart series={[10, 20, 30]} labels={["Oct 1", "Oct 2", "Oct 3"]} height={120} />);
  const chart = screen.getByTestId("line-chart", hidden);
  fireEvent(chart, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 120 } } });
  expect(screen.getByText("Oct 1", hidden)).toBeTruthy();
  fireEvent(chart, "responderGrant", { nativeEvent: { locationX: 150 } });
  expect(screen.getByText("20.00 · Oct 2", hidden)).toBeTruthy();
});
