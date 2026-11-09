import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SwapHoldingsSection } from "@/features/swap/SwapHoldingsSection";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";
import type { SwapHoldingsSnapshot } from "@/domain/wallet/storedSigner";
import holdingsFixture from "../../../modules/gizu-stored-signer/ios/Tests/Fixtures/swap-holdings.json";
import { deferred } from "../../support/renderApp";

jest.mock("@/services/wallet/nativeBridge", () => ({ getStoredSwapSigner: jest.fn() }));
const token = "0x" + "ab".repeat(20);
const snapshot: SwapHoldingsSnapshot = {
  checkedAt: 1_790_000_000_000,
  block: "0x123",
  holdings: [
    {
      token,
      chainId: 4663,
      symbol: "GOOGL",
      decimals: 6,
      balanceAtoms: "1234500",
      batches: [{ id: `${token}:6`, balanceAtoms: "1234500" }],
    },
  ],
};
const read = jest.fn();
const sell = jest.fn();
const reviewSale = jest.fn();
const Stack = createNativeStackNavigator();
function open() {
  return render(
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Home">
          {() => <SwapHoldingsSection onReviewSale={reviewSale} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>,
  );
}
async function showHoldingDetails() {
  fireEvent.press(
    await screen.findByRole("button", { name: "GOOGL holding details", expanded: false }),
  );
}
function showTools() {
  fireEvent.press(screen.getByRole("button", { name: "Holdings tools", expanded: false }));
}
beforeEach(() => {
  reviewSale.mockReset();
  read.mockReset().mockResolvedValue(snapshot);
  sell.mockReset().mockResolvedValue({ phase: "COMPLETE" });
  jest
    .mocked(getStoredSwapSigner)
    .mockReturnValue({ getSwapHoldings: read, sellSwapHolding: sell } as unknown as NonNullable<
      ReturnType<typeof getStoredSwapSigner>
    >);
});

test("restores holdings and sell action independently of the latest swap after remount", async () => {
  const view = open();
  expect(await screen.findByText("1.2345 GOOGL")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Sell GOOGL back to USDC" })).toBeNull();
  expect(screen.queryByText(token)).toBeNull();
  await showHoldingDetails();
  expect(screen.getByText(token)).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "GOOGL holding details", expanded: true }));
  expect(screen.queryByRole("button", { name: "Sell GOOGL back to USDC" })).toBeNull();
  view.unmount();
  open();
  await showHoldingDetails();
  expect(await screen.findByRole("button", { name: "Sell GOOGL back to USDC" })).toBeVisible();
  expect(sell).not.toHaveBeenCalled();
});

test("failed refresh retains balances and disables selling stale data until retry", async () => {
  open();
  await screen.findByText("1.2345 GOOGL");
  await showHoldingDetails();
  showTools();
  read.mockRejectedValueOnce(new Error("RPC secret-sentinel https://provider.invalid/?key=secret"));
  fireEvent.press(screen.getByRole("button", { name: "Refresh token holdings" }));
  await screen.findByText(/Previously loaded balances may be stale/);
  expect(screen.getByRole("alert")).toHaveTextContent(/Couldn’t refresh your holdings/);
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Error details", expanded: false }));
  expect(screen.getByText("Code: HOLDINGS_READ_FAILED")).toBeVisible();
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  expect(screen.getByText("1.2345 GOOGL")).toBeVisible();
  expect(screen.getByRole("button", { name: "Sell GOOGL back to USDC" })).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Retry holdings" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Sell GOOGL back to USDC" })).toBeEnabled();
});

test("one sell invokes native approval with the saved batch and refreshes balances", async () => {
  const pending = deferred<{ phase: string }>();
  sell.mockReturnValueOnce(pending.promise);
  open();
  await showHoldingDetails();
  const button = await screen.findByRole("button", { name: "Sell GOOGL back to USDC" });
  fireEvent.press(button);
  fireEvent.press(button);
  expect(sell).toHaveBeenCalledTimes(1);
  expect(sell).toHaveBeenCalledWith(`${token}:6`, expect.any(String));
  read.mockResolvedValueOnce({ ...snapshot, holdings: [] });
  await act(async () => pending.resolve({ phase: "COMPLETE" }));
  expect(await screen.findByText(/No balances found/)).toBeVisible();
});

test("earlier purchase discovery only reads balances and never creates a swap", async () => {
  const original = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      list: [{ address: token, symbol: "GOOGL", name: "Alphabet", swapListed: true }],
    }),
  });
  try {
    read.mockResolvedValueOnce({ ...snapshot, holdings: [] });
    open();
    await screen.findByText(/No balances found/);
    expect(screen.queryByRole("button", { name: "Find an earlier purchase" })).toBeNull();
    showTools();
    fireEvent.press(screen.getByRole("button", { name: "Find an earlier purchase" }));
    fireEvent.changeText(await screen.findByLabelText("Find purchased token"), "GOOGL");
    read.mockRejectedValueOnce(new Error("temporary balance failure"));
    fireEvent.press(screen.getByRole("button", { name: "Check GOOGL holdings" }));
    fireEvent.press(await screen.findByRole("button", { name: "Retry holdings" }));
    expect(await screen.findByText("1.2345 GOOGL")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(token);
    expect(sell).not.toHaveBeenCalled();
  } finally {
    global.fetch = original;
  }
});

test("shared native holdings retain exact precision and sell the selected allocated batch", async () => {
  read.mockResolvedValue({ ...snapshot, holdings: [holdingsFixture.expected] });
  open();
  expect(await screen.findByText("0.009007199254741003 GOOGL")).toBeVisible();
  await showHoldingDetails();
  fireEvent.press(screen.getByRole("button", { name: "Sell GOOGL back to USDC" }));
  await act(async () => {});
  expect(sell).toHaveBeenCalledWith(`${holdingsFixture.token}:3`, expect.any(String));
});

test("a balance without a complete allocated batch remains visible but cannot sell", async () => {
  read.mockResolvedValue({ ...snapshot, holdings: [{ ...snapshot.holdings[0], batches: [] }] });
  open();
  expect(await screen.findByText("1.2345 GOOGL")).toBeVisible();
  await showHoldingDetails();
  const button = screen.getByRole("button", { name: "Sell GOOGL back to USDC" });
  expect(button).toBeDisabled();
  fireEvent.press(button);
  expect(sell).not.toHaveBeenCalled();
  expect(screen.getByText(/no complete receiving-wallet group/)).toBeVisible();
});

test("failed sale offers status review instead of resubmission or raw errors", async () => {
  sell.mockRejectedValueOnce(new Error("secret-sentinel provider payload"));
  open();
  await showHoldingDetails();
  fireEvent.press(screen.getByRole("button", { name: "Sell GOOGL back to USDC" }));
  await screen.findByText(
    "Couldn’t finish the sale. Check its status in Swap before trying again.",
  );
  await act(async () => {});
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  expect(screen.getByRole("button", { name: "Sell GOOGL back to USDC" })).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Error details", expanded: false }));
  expect(screen.getByText("Code: SALE_STATUS_REQUIRES_REVIEW")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Review swap" }));
  expect(reviewSale).toHaveBeenCalledTimes(1);
  expect(sell).toHaveBeenCalledTimes(1);
});

test("token search failure retries the catalog without signing", async () => {
  const original = global.fetch;
  const fetch = jest
    .fn()
    .mockRejectedValueOnce(new Error("secret-sentinel"))
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        list: [{ address: token, symbol: "GOOGL", name: "Alphabet", swapListed: true }],
      }),
    });
  global.fetch = fetch;
  try {
    open();
    await screen.findByText("1.2345 GOOGL");
    showTools();
    read.mockRejectedValueOnce(new Error("stale balance"));
    fireEvent.press(screen.getByRole("button", { name: "Refresh token holdings" }));
    await screen.findByRole("button", { name: "Retry holdings" });
    fireEvent.press(screen.getByRole("button", { name: "Find an earlier purchase" }));
    await screen.findByText("Couldn’t load the token search.");
    expect(screen.queryByText(/secret-sentinel/)).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Retry token search" }));
    expect(await screen.findByLabelText("Find purchased token")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retry holdings" })).toBeVisible();
    await showHoldingDetails();
    expect(screen.getByRole("button", { name: "Sell GOOGL back to USDC" })).toBeDisabled();
    expect(sell).not.toHaveBeenCalled();
  } finally {
    global.fetch = original;
  }
});
