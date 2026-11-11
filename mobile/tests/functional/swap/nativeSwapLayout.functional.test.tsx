import { tokenCatalogService } from "@/services/tokenCatalog";
import { catalogToken } from "../../support/tokenCatalog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { RefreshControl } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NativeSwapScreen } from "@/features/swap/NativeSwapScreen";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";

jest.mock("@/services/tokenCatalog", () => ({ tokenCatalogService: { list: jest.fn() } }));
jest.mock("@/services/wallet/nativeBridge", () => ({ getStoredSwapSigner: jest.fn() }));
const token = "0x" + "a".repeat(40);
const secondToken = "0x" + "b".repeat(40);
const start = jest.fn();
const readStatus = jest.fn();
const status = {
  operationId: "previous",
  phase: "CANCELLED",
  fundingAddress: "0x" + "1".repeat(40),
};
beforeEach(() => {
  readStatus.mockReset().mockResolvedValue(status);
  jest.mocked(tokenCatalogService.list).mockImplementation(async (query) => {
    const chainId = query.chainId ?? 4663;
    const category = query.category === "other" ? ("other" as const) : ("rwa" as const);
    const tokens = [
      { ...catalogToken, chainId, category, address: token, symbol: "COIN", name: "Coinbase" },
      {
        ...catalogToken,
        chainId,
        category,
        address: secondToken,
        symbol: "GOOGL",
        name: "Alphabet",
      },
    ].filter((item) =>
      `${item.symbol} ${item.name}`.toLowerCase().includes(query.search.toLowerCase()),
    );
    return { list: tokens, total: tokens.length, items: 20, page: query.page };
  });
  jest.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      list: [
        { address: token, symbol: "COIN", name: "Coinbase", decimals: 18, swapListed: true },
        { address: secondToken, symbol: "GOOGL", name: "Alphabet", decimals: 18, swapListed: true },
      ],
    }),
  } as Response);
  start.mockReset().mockResolvedValue({
    ...status,
    phase: "PAUSED",
    targetSymbol: "GOOGL",
    step: "payoutEstimate",
    pausedCode: "QUOTE_REJECTED",
  });
  jest.mocked(getStoredSwapSigner).mockReturnValue({
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: status.fundingAddress }),
    getSwapStatus: readStatus,
    startSwap: start,
  } as unknown as NonNullable<ReturnType<typeof getStoredSwapSigner>>);
});
afterEach(() => jest.restoreAllMocks());

test("new private sale completion shows verified confidential credit without public payout wallets", async () => {
  readStatus.mockResolvedValue({
    ...status,
    phase: "COMPLETE",
    direction: "sell",
    completionTarget: "confidential",
    privateCreditedAtoms: "7700000",
    creditedAtoms: "7700000",
    targetSymbol: "GOOGL",
    holders: 3,
    ordersComplete: 3,
    payoutsSubmitted: 0,
    returnAddresses: [],
  });
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  fireEvent.press(await screen.findByRole("button", { name: "Last swap completed" }));
  expect(await screen.findByText("Verified private USDC credit")).toBeVisible();
  expect(screen.getByText("7.7 USDC")).toBeVisible();
  expect(screen.queryByText("USDC sent to")).toBeNull();
  expect(screen.queryByText("Paid out")).toBeNull();
  expect(
    screen.getByText("Proceeds remain confidential until you withdraw from Gizu."),
  ).toBeVisible();
});

test("selects a searched token and reviews the exact amount without exposing technical details by default", async () => {
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  expect(screen.queryByText("Funding wallet")).toBeNull();
  expect(screen.getByRole("button", { name: "Swap" })).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Choose receive token" }));
  fireEvent.changeText(screen.getByLabelText("Search tokens"), "missing");
  expect(await screen.findByText("No tokens found.")).toBeVisible();
  fireEvent.changeText(screen.getByLabelText("Search tokens"), "alphabet");
  expect(screen.queryByRole("radio", { name: "COIN · Coinbase" })).toBeNull();
  fireEvent.press(await screen.findByRole("radio", { name: "GOOGL · Alphabet" }));
  expect(screen.queryByLabelText("Search tokens")).toBeNull();
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), "1.25");
  expect(screen.getByRole("button", { name: "Swap" })).toBeEnabled();
  expect(start).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(secondToken, "1250000", expect.any(String)),
  );
  expect(await screen.findByText("Swap paused")).toBeVisible();
  expect(screen.queryByText(/QUOTE_REJECTED/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Swap details", expanded: false }));
  expect(screen.getByText(/QUOTE_REJECTED/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel swap" })).toBeVisible();
});

test("a fresh wallet with no saved swap shows no status warning", async () => {
  readStatus.mockResolvedValue({ phase: "NONE" });
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  await waitFor(() => expect(readStatus).toHaveBeenCalled());
  expect(screen.queryByText(/Saved swap status unavailable/)).toBeNull();
  expect(screen.queryByText("Swap in progress")).toBeNull();
  expect(screen.getByRole("button", { name: "Swap" })).toBeVisible();
});

test("a failed status read still shows the warning", async () => {
  readStatus.mockRejectedValue(new Error("storage failure"));
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  expect(await screen.findByText(/Saved swap status unavailable/)).toBeVisible();
});

test("pull-to-refresh reloads saved swap status without a refresh button", async () => {
  readStatus.mockResolvedValue({ phase: "NONE" });
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  readStatus.mockResolvedValue({ ...status, phase: "PAUSED", targetSymbol: "COIN" });
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  expect(await screen.findByText("Swap paused")).toBeVisible();
  expect(readStatus).toHaveBeenCalledTimes(2);
});

test("picker lists only Robinhood stocks without a token type switch", async () => {
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.press(screen.getByRole("button", { name: "Choose receive token" }));
  expect(await screen.findByRole("radio", { name: "COIN · Coinbase" })).toBeEnabled();
  expect(screen.queryByRole("radiogroup", { name: "Token type" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "DeFi" })).toBeNull();
  expect(screen.getAllByLabelText("Robinhood Chain")).toHaveLength(2);
  expect(screen.queryByText("Robinhood")).toBeNull();
  expect(tokenCatalogService.list).toHaveBeenCalledWith(
    expect.objectContaining({ chainId: 4663, category: "rwa", liquidOnly: true, page: 0 }),
    expect.anything(),
  );
  expect(start).not.toHaveBeenCalled();
});

test("picker hides stocks outside the liquid set and never defaults to one", async () => {
  jest.mocked(tokenCatalogService.list).mockImplementation(async (query) => {
    const tokens = [
      {
        ...catalogToken,
        address: secondToken,
        symbol: "GOOGL",
        name: "Alphabet • Robinhood Token",
        buyable: true,
      },
      { ...catalogToken, address: token, symbol: "COIN", name: "Coinbase", buyable: false },
    ].filter((item) => !query.liquidOnly || item.buyable);
    return { list: tokens, total: tokens.length, items: 20, page: query.page };
  });
  jest.mocked(globalThis.fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      list: [
        {
          address: token,
          symbol: "COIN",
          name: "Coinbase",
          decimals: 18,
          swapListed: true,
          buyable: false,
        },
        {
          address: secondToken,
          symbol: "GOOGL",
          name: "Alphabet • Robinhood Token",
          decimals: 18,
          swapListed: true,
          buyable: true,
        },
      ],
    }),
  } as Response);
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("GOOGL");
  fireEvent.press(screen.getByRole("button", { name: "Choose receive token" }));
  expect(
    await screen.findByRole("radio", { name: "GOOGL · Alphabet", checked: true }),
  ).toBeEnabled();
  expect(screen.queryByRole("radio", { name: "COIN · Coinbase" })).toBeNull();
  // The list row and the "You receive" note both drop Robinhood's name suffix.
  expect(screen.getAllByText("Alphabet").length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText(/Robinhood Token/)).toBeNull();
  expect(screen.queryByText(/most liquid Robinhood stocks/)).toBeNull();
  expect(tokenCatalogService.list).toHaveBeenCalledWith(
    expect.objectContaining({ chainId: 4663, category: "rwa", liquidOnly: true }),
    expect.anything(),
  );
});

test("a native HTTP failure shows actionable guidance instead of a bare code", async () => {
  start.mockRejectedValue(new Error("HTTP"));
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), "1");
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  expect(
    await screen.findByText(/A balance or swap service could not complete the request/),
  ).toBeVisible();
  expect(screen.queryByText("HTTP")).toBeNull();
});

const paused = (over: Record<string, unknown>) => ({
  ...status,
  phase: "PAUSED",
  targetSymbol: "AMZN",
  approved: true,
  direction: "sell",
  ordersComplete: 0,
  payoutsSubmitted: 0,
  pausedCode: "QUOTE_REJECTED",
  ...over,
});

test("an approved sale that stopped before any order was signed can be cancelled", async () => {
  readStatus.mockResolvedValue(paused({}));
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  expect(await screen.findByText("Swap paused")).toBeVisible();
  expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel swap" })).toBeVisible();
  expect(screen.queryByText(/can only be resumed/)).toBeNull();
});

test("an approved swap that may have moved funds still offers only Resume", async () => {
  for (const over of [
    { direction: "buy" },
    { ordersComplete: 1 },
    { payoutsSubmitted: 1 },
    { pausedCode: "FUSION_1_UNFILLED" },
  ]) {
    readStatus.mockResolvedValue(paused(over));
    const view = render(
      <SafeAreaProvider>
        <NativeSwapScreen />
      </SafeAreaProvider>,
    );
    expect(await screen.findByText(/can only be resumed/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel swap" })).toBeNull();
    view.unmount();
  }
});

const finished = (over: Record<string, unknown>) => ({
  ...status,
  targetSymbol: "AMZN",
  direction: "buy",
  ordersComplete: 2,
  payoutsSubmitted: 2,
  returnAddresses: [],
  ...over,
});

test.each([
  ["COMPLETE", "Last swap completed", /Swapped USDC → AMZN/],
  ["CANCELLED", "Last swap cancelled", /Swap cancelled/],
])(
  "a %s swap leaves the swap form in front and keeps its status behind an info button",
  async (phase, label, summary) => {
    readStatus.mockResolvedValue(finished({ phase }));
    render(
      <SafeAreaProvider>
        <NativeSwapScreen />
      </SafeAreaProvider>,
    );
    const info = await screen.findByRole("button", { name: label });
    expect(screen.getByRole("button", { name: "Swap" })).toBeVisible();
    expect(screen.queryByText("Swap completed")).toBeNull();
    expect(screen.queryByText("Swap cancelled")).toBeNull();
    expect(screen.queryByText(summary)).toBeNull();
    fireEvent.press(info);
    expect(await screen.findByText(summary)).toBeVisible();
    expect(screen.getByRole("button", { name: label, expanded: true })).toBeVisible();
    fireEvent.press(screen.getByRole("button", { name: label }));
    expect(screen.queryByText(summary)).toBeNull();
  },
);

async function openSummary(label: string) {
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  fireEvent.press(await screen.findByRole("button", { name: label }));
}

test("a finished buy says what was paid, what arrived and how it was split, in plain words", async () => {
  readStatus.mockResolvedValue(
    finished({
      phase: "COMPLETE",
      sourceAtoms: "1997000",
      receivedTargetAtoms: "2210000000000000",
      targetDecimals: 18,
      payoutsSubmitted: 2,
      ordersComplete: 2,
      legs: 2,
    }),
  );
  await openSummary("Last swap completed");
  expect(await screen.findByText("Swapped USDC → AMZN")).toBeVisible();
  expect(screen.getByText("You paid")).toBeVisible();
  expect(screen.getByText("1.997 USDC")).toBeVisible();
  expect(screen.getByText("Split across")).toBeVisible();
  expect(screen.getByText("2 wallets")).toBeVisible();
  expect(screen.queryByText(/payouts/i)).toBeNull();
  expect(screen.queryByText(/orders/i)).toBeNull();
});

test("a swap cancelled before anything happened says nothing was bought", async () => {
  readStatus.mockResolvedValue(
    finished({ phase: "CANCELLED", ordersComplete: 0, payoutsSubmitted: 0 }),
  );
  await openSummary("Last swap cancelled");
  expect(await screen.findByText("Swap cancelled")).toBeVisible();
  expect(screen.getByText(/Nothing was swapped and nothing is pending/)).toBeVisible();
  expect(screen.queryByText("Finished")).toBeNull();
});

test("a swap cancelled partway reports how far it got", async () => {
  readStatus.mockResolvedValue(
    finished({
      phase: "CANCELLED",
      ordersComplete: 1,
      payoutsSubmitted: 2,
      legs: 3,
      receivedTargetAtoms: "1000000000000000",
      targetDecimals: 18,
    }),
  );
  await openSummary("Last swap cancelled");
  expect(await screen.findByText(/Stopped partway/)).toBeVisible();
  expect(screen.getByText("1 of 3 wallets")).toBeVisible();
  expect(screen.getByText("0.001 AMZN")).toBeVisible();
});

test("a finished sale names what was sold, where it went and tucks addresses away", async () => {
  const address = "0x" + "c".repeat(40);
  readStatus.mockResolvedValue(
    finished({
      phase: "COMPLETE",
      direction: "sell",
      ordersComplete: 2,
      payoutsSubmitted: 2,
      legs: 3,
      returnAddresses: [address],
    }),
  );
  await openSummary("Last swap completed");
  expect(await screen.findByText("Swapped AMZN → USDC")).toBeVisible();
  expect(screen.getByText("2 of 3 wallets")).toBeVisible();
  expect(screen.getByText("2 wallets on Monad")).toBeVisible();
  expect(screen.queryByText(address)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Wallet addresses" }));
  expect(await screen.findByText(address)).toBeVisible();
  expect(screen.getByText("0xcccc…cccc")).toBeVisible();
});

test("a swap that still needs attention keeps its prominent card and no info button", async () => {
  readStatus.mockResolvedValue(finished({ phase: "PAUSED", pausedCode: "QUOTE_REJECTED" }));
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  expect(await screen.findByText("Swap paused")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Last swap/ })).toBeNull();
});

test("a pooled sale reports how many wallets it sold from and how many it paid", async () => {
  readStatus.mockResolvedValue(
    finished({
      phase: "COMPLETE",
      direction: "sell",
      ordersComplete: 3,
      payoutsSubmitted: 2,
      holders: 3,
      legs: 2,
      creditedAtoms: "29700000",
    }),
  );
  await openSummary("Last swap completed");
  expect(await screen.findByText("Swapped AMZN → USDC")).toBeVisible();
  expect(screen.getByText("3 of 3 wallets")).toBeVisible();
  expect(screen.getByText("2 wallets on Monad")).toBeVisible();
  expect(screen.getByText("Paid out")).toBeVisible();
  expect(screen.getByText("29.7 USDC")).toBeVisible();
});

test("a token gas allowance rejection shows a recovery action without raw provider details", async () => {
  start.mockResolvedValue({
    ...status,
    phase: "PAUSED",
    targetSymbol: "COIN",
    pausedCode: "TOKEN_PAYMASTER_ALLOWANCE_LOW",
  });
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), "1.25");
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  expect(
    await screen.findByText(
      "The USDC gas approval is below the required maximum. Resume to prepare it again before signing.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("TOKEN_PAYMASTER_ALLOWANCE_LOW")).toBeNull();
});

test("the market preview states that fees are excluded", async () => {
  jest.mocked(globalThis.fetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () =>
          String(url).includes("fusion/preview")
            ? { marketOut: "1000000000000000000" }
            : {
                list: [
                  {
                    address: token,
                    symbol: "COIN",
                    name: "Coinbase",
                    decimals: 18,
                    swapListed: true,
                  },
                ],
              },
      }) as Response,
  );
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), "1.25");
  expect(screen.queryByText(/Market estimate before fees/)).toBeNull();
  fireEvent.press(await screen.findByRole("button", { name: "About this estimate" }));
  expect(screen.getByText(/Market estimate before fees/)).toBeVisible();
});

test("native action failures keep provider details out of the screen", async () => {
  const providerDetail = "provider request details must stay private";
  start.mockRejectedValue(new Error(providerDetail));
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.changeText(screen.getByLabelText("Amount in USDC"), "1.25");
  fireEvent.press(screen.getByRole("button", { name: "Swap" }));
  expect(
    await screen.findByText("Swap stopped. Refresh the saved swap status before trying again."),
  ).toBeVisible();
  expect(screen.queryByText(providerDetail)).toBeNull();
});

test("sell mode offers only the selected holding sale after an earlier completed buy", async () => {
  readStatus.mockResolvedValue({
    ...status,
    phase: "COMPLETE",
    direction: "buy",
    receivedTargetAtoms: "1000000",
    targetSymbol: "COIN",
  });
  jest.mocked(getStoredSwapSigner).mockReturnValue({
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: status.fundingAddress }),
    getSwapStatus: readStatus,
    getSwapHoldings: jest.fn().mockResolvedValue({ holdings: [], checkedAt: 1, block: "0x1" }),
  } as unknown as NonNullable<ReturnType<typeof getStoredSwapSigner>>);
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  expect(await screen.findByRole("button", { name: "Swap to USDC" })).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Reverse direction" }));
  expect(screen.queryByRole("button", { name: "Swap to USDC" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Choose token to sell" })).toBeVisible();
});
