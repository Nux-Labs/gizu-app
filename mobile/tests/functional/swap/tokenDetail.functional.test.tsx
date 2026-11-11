import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NativeSwapScreen } from "@/features/swap/NativeSwapScreen";
import { tokenCatalogService } from "@/services/tokenCatalog";
import { tokenDetailsService } from "@/services/tokenDetails";
import { getStoredSwapSigner } from "@/services/wallet/nativeBridge";
import type { TokenDetails } from "@/domain/tokenDetails";
import { catalogToken } from "../../support/tokenCatalog";
import { tokenDetails } from "../../support/tokenDetails";

jest.mock("@/services/tokenCatalog", () => ({ tokenCatalogService: { list: jest.fn() } }));
jest.mock("@/services/tokenDetails", () => ({ tokenDetailsService: { details: jest.fn() } }));
jest.mock("@/services/wallet/nativeBridge", () => ({ getStoredSwapSigner: jest.fn() }));

const coin = "0x" + "a".repeat(40);
const googl = tokenDetails.address;
const status = {
  operationId: "previous",
  phase: "CANCELLED",
  fundingAddress: "0x" + "1".repeat(40),
};
const details = jest.mocked(tokenDetailsService.details);

beforeEach(() => {
  jest.mocked(tokenCatalogService.list).mockImplementation(async (query) => {
    const tokens = [
      {
        ...catalogToken,
        address: coin,
        symbol: "COIN",
        name: "Coinbase • Robinhood Token",
        buyable: true,
      },
      {
        ...catalogToken,
        address: googl,
        symbol: "GOOGL",
        name: "Alphabet Class A • Robinhood Token",
        buyable: true,
      },
    ];
    return { list: tokens, total: tokens.length, items: 20, page: query.page };
  });
  jest.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      list: [
        {
          address: coin,
          symbol: "COIN",
          name: "Coinbase",
          decimals: 18,
          swapListed: true,
          buyable: true,
        },
        {
          address: googl,
          symbol: "GOOGL",
          name: "Alphabet",
          decimals: 18,
          swapListed: true,
          buyable: true,
        },
      ],
    }),
  } as Response);
  details.mockReset().mockImplementation(async (_, period) => ({
    ...tokenDetails,
    chart: tokenDetails.chart && { ...tokenDetails.chart, period },
  }));
  jest.mocked(getStoredSwapSigner).mockReturnValue({
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: status.fundingAddress }),
    getSwapStatus: jest.fn().mockResolvedValue(status),
    startSwap: jest.fn(),
  } as unknown as NonNullable<ReturnType<typeof getStoredSwapSigner>>);
});
afterEach(() => jest.restoreAllMocks());

async function openDetails(symbol: string) {
  render(
    <SafeAreaProvider>
      <NativeSwapScreen />
    </SafeAreaProvider>,
  );
  await screen.findByText("COIN");
  fireEvent.press(screen.getByRole("button", { name: "Choose receive token" }));
  const info = await screen.findByRole("button", { name: `${symbol} details` });
  // The first details request settles inside act, like a user waiting for the page.
  await act(async () => fireEvent.press(info));
}

test("the info button opens a stock's details without selecting it, and Back returns to the list", async () => {
  await openDetails("GOOGL");
  expect(await screen.findByText("Alphabet Class A")).toBeVisible();
  expect(screen.getByText("$312.40")).toBeVisible();
  expect(screen.getByText("+4.13% · 1M")).toBeVisible();
  expect(screen.getByText(tokenDetails.description)).toBeVisible();
  expect(screen.getByLabelText("ISIN: US02079K3059")).toBeVisible();
  expect(screen.getByLabelText("Shares per token: 1.0005")).toBeVisible();
  expect(screen.getByLabelText("Trading: Regular hours · Extended hours")).toBeVisible();
  expect(screen.getByText(/can differ from the exchange price/)).toBeVisible();
  expect(details).toHaveBeenCalledWith(googl, "1M", expect.anything());
  fireEvent.press(screen.getByRole("button", { name: "Back to tokens" }));
  expect(
    await screen.findByRole("radio", { name: "COIN · Coinbase", checked: true }),
  ).toBeVisible();
  expect(
    screen.getByRole("radio", { name: "GOOGL · Alphabet Class A", checked: false }),
  ).toBeVisible();
});

test("choosing a period reloads the chart and Select makes the token the swap target", async () => {
  await openDetails("GOOGL");
  await screen.findByText("+4.13% · 1M");
  fireEvent.press(screen.getByRole("radio", { name: "1W" }));
  expect(await screen.findByText("+4.13% · 1W")).toBeVisible();
  expect(details).toHaveBeenLastCalledWith(googl, "1W", expect.anything());
  fireEvent.press(screen.getByRole("button", { name: "Select GOOGL" }));
  expect(await screen.findByRole("button", { name: "Choose receive token" })).toBeVisible();
  expect(screen.queryByText("Back to tokens")).toBeNull();
  expect(screen.getByText("GOOGL")).toBeVisible();
});

test("a fund without price history says so instead of drawing a chart", async () => {
  details.mockResolvedValue({
    ...tokenDetails,
    kind: "fund",
    chart: null,
    priceUsd: null,
    isin: null,
  });
  await openDetails("GOOGL");
  expect(await screen.findByText("Price history isn’t available for this token.")).toBeVisible();
  expect(screen.getAllByText("Fund").length).toBeGreaterThan(0);
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.queryByLabelText(/ISIN/)).toBeNull();
});

test("a failed load offers a retry that recovers", async () => {
  let fail = true;
  let release: (value: TokenDetails) => void = () => undefined;
  details.mockImplementation(() =>
    fail
      ? Promise.reject(new Error("provider secret"))
      : new Promise((resolve) => (release = resolve)),
  );
  await openDetails("COIN");
  expect(await screen.findByText("Token details are unavailable right now.")).toBeVisible();
  expect(screen.queryByText(/provider secret/)).toBeNull();
  fail = false;
  fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("Loading token details")).toBeVisible();
  await act(async () =>
    release({ ...tokenDetails, address: coin, symbol: "COIN", name: "Coinbase" }),
  );
  expect(await screen.findByRole("button", { name: "Select COIN" })).toBeVisible();
});
