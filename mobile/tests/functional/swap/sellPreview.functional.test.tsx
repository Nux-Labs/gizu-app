import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NativeSwapScreen } from "@/features/swap/NativeSwapScreen";
import { ROBINHOOD_USDG } from "@/features/swap/confidentialSwap";
import { parseTokenAmount } from "@/domain/swap";
import type { SwapHoldingsSnapshot } from "@/domain/wallet/storedSigner";
import { tokenCatalogService } from "@/services/tokenCatalog";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";
import { catalogToken } from "../../support/tokenCatalog";

jest.mock("@/services/tokenCatalog", () => ({ tokenCatalogService: { list: jest.fn() } }));
jest.mock("@/services/wallet/nativeBridge", () => ({ getStoredSwapSigner: jest.fn() }));

const fundingAddress = "0x" + "1".repeat(40);
const held = "0x" + "ab".repeat(20);
const withHolding: SwapHoldingsSnapshot = {
  checkedAt: 1_790_000_000_000,
  block: "0x123",
  holdings: [
    {
      token: held,
      chainId: 4663,
      symbol: "GOOGL",
      decimals: 6,
      balanceAtoms: "1234500",
      batches: [{ id: `${held}:6`, balanceAtoms: "1234500" }],
    },
  ],
};
const empty: SwapHoldingsSnapshot = { checkedAt: 1_790_000_000_000, block: "0x123", holdings: [] };
const holdingsRead = jest.fn();
const sell = jest.fn();
let previewBodies: Record<string, unknown>[] = [];
let previewOk = true;

beforeEach(() => {
  previewBodies = [];
  previewOk = true;
  holdingsRead.mockReset();
  sell.mockReset();
  jest.mocked(tokenCatalogService.list).mockResolvedValue({
    list: [catalogToken],
    total: 1,
    items: 20,
    page: 0,
  });
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("fusion/preview")) {
      previewBodies.push(JSON.parse(String(init?.body)));
      return { ok: previewOk, json: async () => ({ marketOut: "12500000" }) } as Response;
    }
    return { ok: true, json: async () => ({ list: [] }) } as Response;
  });
  jest.mocked(getStoredSwapSigner).mockReturnValue({
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress }),
    getSwapStatus: jest.fn().mockResolvedValue({ phase: "NONE" }),
    getSwapHoldings: holdingsRead,
    sellSwapHolding: sell,
  } as unknown as NonNullable<ReturnType<typeof getStoredSwapSigner>>);
});
afterEach(() => jest.restoreAllMocks());

function openSell() {
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  fireEvent.press(screen.getByRole("button", { name: "Reverse direction" }));
}

test("a held token shows the estimated USDC for its full balance", async () => {
  holdingsRead.mockResolvedValue(withHolding);
  openSell();
  expect(await screen.findByLabelText("Estimated 12.5 USDC")).toBeVisible();
  expect(screen.getByText("Available: 1.2345 GOOGL")).toBeVisible();
  expect(screen.queryByText(/Market estimate before fees/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "About this estimate" }));
  expect(screen.getByText(/Market estimate before fees/)).toBeVisible();
  expect(previewBodies.at(-1)).toEqual({
    wallet: fundingAddress,
    srcToken: held,
    dstToken: ROBINHOOD_USDG,
    amount: "1234500",
    preset: "fast",
  });
  expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
});

test("one Swap sells all wallet groups while estimating the total balance", async () => {
  holdingsRead.mockResolvedValue({
    ...withHolding,
    holdings: [
      {
        ...withHolding.holdings[0],
        balanceAtoms: "9000000",
        batches: [
          { id: `${held}:3`, balanceAtoms: "3000000" },
          { id: `${held}:6`, balanceAtoms: "6000000" },
        ],
      },
    ],
  });
  sell.mockResolvedValue({ phase: "COMPLETE", completionTarget: "confidential" });
  openSell();
  expect(await screen.findByLabelText("Estimated 12.5 USDC")).toBeVisible();
  expect(screen.getByText("Available: 9 GOOGL")).toBeVisible();
  expect(previewBodies.at(-1)).toMatchObject({ srcToken: held, amount: "9000000" });
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  await waitFor(() => expect(sell).toHaveBeenCalledWith(`${held}:all`, expect.any(String)));
  expect(sell).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(holdingsRead.mock.calls.length).toBeGreaterThan(1));
});

test("a balance in a partial wallet group can still be sold", async () => {
  holdingsRead.mockResolvedValue({
    ...withHolding,
    holdings: [{ ...withHolding.holdings[0], batches: [] }],
  });
  openSell();
  expect(await screen.findByLabelText("Estimated 12.5 USDC")).toBeVisible();
  expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
});

test("without holdings any swap token can be previewed but not sold", async () => {
  holdingsRead.mockResolvedValue(empty);
  openSell();
  fireEvent.press(await screen.findByRole("button", { name: "Choose token to sell" }));
  expect(screen.queryByText("No sellable tokens found in your swap wallets.")).toBeNull();
  expect(screen.queryByText(/Choose a token to preview a sale/)).toBeNull();
  expect(screen.queryByText(/withdraw from Gizu separately/)).toBeNull();
  fireEvent.press(await screen.findByRole("radio", { name: "AMZN · Amazon" }));
  fireEvent.changeText(screen.getByLabelText("Amount to sell"), "2");
  expect(await screen.findByLabelText("Estimated 12.5 USDC")).toBeVisible();
  expect(screen.getByText("Available: 0 AMZN")).toBeVisible();
  expect(screen.queryByText(/you don't hold/)).toBeNull();
  expect(previewBodies.at(-1)).toMatchObject({
    srcToken: catalogToken.address,
    dstToken: ROBINHOOD_USDG,
    amount: (2n * 10n ** 18n).toString(),
  });
  expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
  expect(sell).not.toHaveBeenCalled();
});

test("a failed estimate says so without blocking the form", async () => {
  previewOk = false;
  holdingsRead.mockResolvedValue(withHolding);
  openSell();
  expect(await screen.findByText("Estimate unavailable")).toBeVisible();
  expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
});

test("with several holdings the token chip opens a chooser instead of a row of chips", async () => {
  const second = "0x" + "cd".repeat(20);
  holdingsRead.mockResolvedValue({
    ...withHolding,
    holdings: [
      ...withHolding.holdings,
      {
        token: second,
        chainId: 4663,
        symbol: "AMZN",
        decimals: 6,
        balanceAtoms: "2000000",
        batches: [{ id: `${second}:7`, balanceAtoms: "2000000" }],
      },
    ],
  });
  openSell();
  fireEvent.press(await screen.findByRole("button", { name: "Choose held token" }));
  fireEvent.press(screen.getByRole("radio", { name: "AMZN" }));
  expect(await screen.findByRole("button", { name: "Swap" })).toBeEnabled();
  expect(screen.getByText("2")).toBeVisible();
  await screen.findByLabelText("Estimated 12.5 USDC");
  expect(previewBodies.at(-1)).toMatchObject({ srcToken: second, amount: "2000000" });
});

test("token amounts parse at the token's own precision", () => {
  expect(parseTokenAmount("2", 18)).toBe(2n * 10n ** 18n);
  expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
  expect(parseTokenAmount("1.1234567", 6)).toBeNull();
  expect(parseTokenAmount("01", 6)).toBeNull();
  expect(parseTokenAmount("1.", 6)).toBeNull();
  expect(parseTokenAmount("7", 0)).toBe(7n);
  expect(parseTokenAmount("7.1", 0)).toBeNull();
});
