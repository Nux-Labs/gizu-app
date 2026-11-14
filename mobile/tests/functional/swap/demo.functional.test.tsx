import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NativeSwapScreen } from "@/features/swap/NativeSwapScreen";
import { DemoSwapSheet } from "@/features/swap/demo/DemoSwapSheet";
import { demoLegs, swapDemo } from "@/features/swap/demo/swapDemo";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";

// Demo mode must never reach the native signer.
jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredSwapSigner: jest.fn(() => {
    throw new Error("the demo used the native signer");
  }),
}));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function open() {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <NativeSwapScreen />
      <DemoSwapSheet />
    </SafeAreaProvider>,
  );
}

/** Lets the simulated swap run to its end. */
async function runToEnd() {
  for (let i = 0; i < 80 && !screen.queryByRole("button", { name: "Done" }); i++)
    await act(() => jest.advanceTimersByTimeAsync(1_000));
}

async function buy(amount: string) {
  await screen.findByText("Balance 250");
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), amount);
  fireEvent.press(screen.getByRole("button", { name: "Review swap" }));
  expect(await screen.findByText("CONFIDENTIAL SWAP · MAINNET")).toBeVisible();
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_SWAP_DEMO = "1";
  jest.useFakeTimers();
  swapDemo.reset();
});
afterEach(() => {
  swapDemo.reset();
  jest.useRealTimers();
  delete process.env.EXPO_PUBLIC_SWAP_DEMO;
});

test("a demo buy reviews, approves, runs every step and lands in holdings", async () => {
  open();
  // A demo carries no demo label: it must look like the real app.
  await screen.findByText("Balance 250");
  expect(screen.queryByText(/demo/i)).toBeNull();
  await buy("30");
  // 30 USDC is in the 20-100 tier: two or three fresh wallets.
  expect(screen.getAllByText(/^Payout \d of [23]$/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("30 USDC")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Approve for 15 minutes" }));
  expect(screen.getByText("Confirm with your passkey")).toBeVisible();
  await act(() => jest.advanceTimersByTimeAsync(1_000));
  const sheet = within(await screen.findByLabelText("Swap review and progress"));
  expect(await sheet.findByText("Swap in progress")).toBeVisible();
  fireEvent.press(sheet.getByRole("button", { name: "Demo swap progress details" }));
  expect(sheet.getByText("Move USDC to the private balance")).toBeVisible();
  await runToEnd();
  expect(screen.getByText(/^Bought 0\.1\d+ AMZN$/)).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByText("Balance 220")).toBeVisible();
  expect(screen.getByRole("button", { name: "Last swap completed" })).toBeVisible();
  expect(getStoredSwapSigner).not.toHaveBeenCalled();
});

test("a demo sell pools the holdings and pays USDC back", async () => {
  open();
  await buy("30");
  fireEvent.press(screen.getByRole("button", { name: "Approve for 15 minutes" }));
  await runToEnd();
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  fireEvent.press(await screen.findByRole("button", { name: "Switch to selling" }));
  // A demo shows only what users get: no debug sweep, and the sale button simply says Swap.
  // Wait for the holdings to load: until then the button has nothing to sell.
  await waitFor(() => expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled());
  expect(screen.queryByText(/Debug: send/)).toBeNull();
  expect(screen.queryByText(/back to Monad USDC|for USDC$/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  expect(await screen.findByText("CONFIDENTIAL SELL · MAINNET")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Approve for 15 minutes" }));
  await runToEnd();
  expect(screen.getByText("Sold AMZN")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  // Price and fees make the round trip cost a little, never create money.
  const back = Number(swapDemo.usdcAtoms()) / 1e6;
  expect(back).toBeGreaterThan(249);
  expect(back).toBeLessThan(250);
});

test("a demo swap keeps running after Continue in background and reports when it ends", async () => {
  open();
  await buy("10");
  fireEvent.press(screen.getByRole("button", { name: "Approve for 15 minutes" }));
  await act(() => jest.advanceTimersByTimeAsync(1_500));
  fireEvent.press(await screen.findByRole("button", { name: "Continue in background" }));
  expect(await screen.findByText("Swap in progress")).toBeVisible();
  expect(screen.queryByText("Continue in background")).toBeNull();
  for (let i = 0; i < 60 && swapDemo.status()?.phase !== "COMPLETE"; i++)
    await act(() => jest.advanceTimersByTimeAsync(1_000));
  expect(await screen.findByRole("button", { name: "Last swap completed" })).toBeVisible();
  expect(screen.queryByText("Swap in progress")).toBeNull();
});

test("cancelling a demo review moves nothing", async () => {
  open();
  await buy("10");
  fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("button", { name: "Last swap cancelled" })).toBeVisible();
  expect(screen.getByText("Balance 250")).toBeVisible();
});

test("demo wallet counts and shares follow the engine's rules", () => {
  for (let n = 0; n < 200; n++) {
    const small = demoLegs(4_000_000n);
    expect(small).toEqual({ count: 1, weights: [10_000] });
    const mid = demoLegs(50_000_000n);
    expect([2, 3]).toContain(mid.count);
    expect(mid.weights.reduce((a, b) => a + b, 0)).toBe(10_000);
    const equal = 10_000 / mid.count;
    for (const w of mid.weights) {
      expect(w).toBeGreaterThanOrEqual(Math.ceil(equal * 0.7));
      expect(w).toBeLessThanOrEqual(Math.floor(equal * 1.3));
    }
  }
});
