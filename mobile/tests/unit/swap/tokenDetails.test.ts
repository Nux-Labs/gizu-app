import { periodChange, sessionNames } from "@/domain/tokenDetails";

test("period change compares the first and last chart prices", () => {
  const chart = (prices: number[]) => ({
    chart: { period: "1M" as const, points: prices.map((price, time) => ({ time, price })) },
  });
  expect(periodChange(chart([200, 250]))).toBeCloseTo(25);
  expect(periodChange(chart([200, 150]))).toBeCloseTo(-25);
  expect(periodChange({ chart: null })).toBeNull();
});

test("sessions are named in trading-day order and omitted when closed", () => {
  expect(sessionNames({ regular: true, extended: false, overnight: true })).toEqual([
    "Regular hours",
    "24 Hour Market",
  ]);
  expect(sessionNames({ regular: false, extended: false, overnight: false })).toEqual([]);
});
