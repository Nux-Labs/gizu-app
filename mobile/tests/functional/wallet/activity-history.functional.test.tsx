import { render, screen, userEvent } from "@testing-library/react-native";
import { ActivityHistory } from "@/features/wallet/ActivityHistory";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";

const entries: MainnetPortfolioSnapshot["history"] = [
  {
    operationId: "buy-1",
    phase: "COMPLETE",
    direction: "buy",
    symbol: "GOOGL",
    receivedAtoms: "123456",
    recordedAt: 1_800_000_000_000,
  },
  {
    operationId: "sell-1",
    phase: "COMPLETE",
    direction: "sell",
    symbol: "NVDA",
    receivedAtoms: "9800000",
    recordedAt: 1_800_000_001_000,
  },
  {
    operationId: "sell-2",
    phase: "CANCELLED",
    direction: "sell",
    symbol: "TSLA",
    receivedAtoms: "0",
    recordedAt: 1_800_000_002_000,
  },
];

test("filters actual swap records and keeps cancelled sales distinct from completed proceeds", async () => {
  render(<ActivityHistory entries={entries} />);
  expect(screen.getByText("Sold NVDA")).toBeVisible();
  expect(screen.getByText("Sell TSLA")).toBeVisible();
  expect(screen.queryByText("Sold TSLA")).toBeNull();
  expect(screen.getByText("Returned 9.8 USDC on Monad")).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "Buys" }));
  expect(screen.getByText("Bought GOOGL")).toBeVisible();
  expect(screen.queryByText("Sold NVDA")).toBeNull();
  await userEvent.press(screen.getByRole("radio", { name: "Sells" }));
  expect(screen.queryByText("Bought GOOGL")).toBeNull();
  expect(screen.getByText("Sold NVDA")).toBeVisible();
});

test("opens a transaction reference without turning incomplete buy metadata into a token quantity", async () => {
  render(<ActivityHistory entries={[entries[0]!]} />);
  expect(screen.queryByText(/Reference:/)).toBeNull();
  expect(screen.queryByText(/0.123456/)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Details for buy-1" }));
  expect(screen.getByText("Reference: buy-1")).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "Sells" }));
  expect(screen.getByText("No swaps match this filter.")).toBeVisible();
});
