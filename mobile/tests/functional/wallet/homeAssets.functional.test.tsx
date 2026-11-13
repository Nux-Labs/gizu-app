import { fireEvent, render, screen, userEvent } from "@testing-library/react-native";
import { Linking, Platform, RefreshControl } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { AppRoot } from "@/application/AppRoot";
import { defaultPreferences } from "@/domain/preferences";
import type { CatalogToken, TokenQuery } from "@/domain/tokenCatalog";
import type { OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { marketValueAtoms } from "@/features/wallet/usePortfolioTokenNames";
import { tokenCatalogService } from "@/services/tokenCatalog";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import { mainnetPortfolio } from "../../support/mainnetWallet";

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));

const originalOS = Platform.OS;
const originalVersion = Platform.Version;
const address = "0x" + "1".repeat(40);
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const intc = "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681";
const googl = "0x" + "ab".repeat(20);
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const state = {
  status: "ready",
  walletId,
  accounts: [{ accountIndex: 0, address, chainId: 10143 }],
};
const readHoldings = jest.fn();

function catalogRow(token: string, symbol: string, name: string, priceUsd?: number): CatalogToken {
  return {
    chainId: 4663,
    address: token,
    symbol,
    name: `${name} • Robinhood Token`,
    decimals: 18,
    logoURI: null,
    category: "rwa",
    issuer: "Robinhood",
    swapListed: true,
    buyable: priceUsd !== undefined,
    fusionStatus: "quote-required",
    ...(priceUsd !== undefined ? { priceUsd } : {}),
  };
}

function stock(token: string, balanceAtoms: string): OwnedPortfolioAsset {
  return {
    assetId: `4663:${token}`,
    chainId: 4663,
    token,
    symbol: `Token ${token.slice(-6)}`,
    decimals: null,
    balanceAtoms,
    observedAtoms: balanceAtoms,
    complete: true,
    stale: false,
    checkedAt: 1,
    valueUsdcAtoms: null,
    valuationUnavailable: true,
  };
}

function stable(token: string, symbol: string, balanceAtoms: string, chainId = 4663) {
  return {
    ...stock(token, balanceAtoms),
    assetId: `${chainId}:${token}`,
    chainId,
    symbol,
    decimals: 6,
  };
}

beforeEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  readHoldings.mockReset().mockResolvedValue({ checkedAt: 1, block: "0x1", holdings: [] });
  jest.mocked(requireOptionalNativeModule).mockReturnValue({
    getCapabilities: jest.fn().mockResolvedValue({
      contractVersion: 1,
      available: true,
      swaps: true,
      confidentialSaleProceeds: true,
    }),
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: address }),
    getSwapStatus: jest.fn().mockResolvedValue({ phase: "NONE" }),
    getSwapHoldings: readHoldings,
    sellSwapHolding: jest.fn(),
  });
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener");
  jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        ({ ok: true, json: async () => ({ list: [], marketOut: "1000000" }) }) as Response,
    );
  jest.spyOn(tokenCatalogService, "list").mockImplementation(async (query: TokenQuery) => {
    const rows = [
      catalogRow(intc, "INTC", "Intel", 60),
      catalogRow(googl, "GOOGL", "Alphabet"),
    ].filter((row) => !query.search || row.address === query.search);
    return { list: rows, page: 0, items: 20, total: rows.length };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  Object.defineProperty(Platform, "Version", { configurable: true, value: originalVersion });
});

function setup(snapshot = mainnetPortfolio(walletId, address)) {
  const native = {
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: address }),
    getWalletState: jest.fn().mockResolvedValue(state),
    openWallet: jest.fn().mockResolvedValue(state),
    createWallet: jest.fn(),
    backupWallet: jest.fn(),
    restoreWallet: jest.fn(),
    lock: jest.fn(),
  };
  const portfolio = { getMainnetPortfolio: jest.fn().mockResolvedValue(snapshot) };
  render(
    <AppRoot
      mainnetPortfolioService={portfolio}
      accessService={createStoredWalletAccess(() => native)}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("0") }}
      walletTransferService={{
        history: jest.fn().mockResolvedValue({ entries: [], blocked: false }),
        send: jest.fn(),
        cancel: jest.fn(),
      }}
      opportunityService={{
        list: jest.fn().mockResolvedValue({ list: [], page: 0, items: 8, total: 0 }),
        detail: jest.fn(),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
      accountDependencies={{
        clipboard: { copy: jest.fn() },
        store: {
          load: jest.fn().mockResolvedValue(defaultPreferences),
          save: jest.fn(),
          clear: jest.fn(),
        },
      }}
    />,
  );
  return { portfolio };
}

async function open() {
  await userEvent.press(await screen.findByRole("button", { name: "Unlock wallet" }));
}

function assetRows() {
  return screen
    .getAllByRole("button", { name: / holding details$/ })
    .map((row) => row.props.accessibilityLabel.replace(/ holding details$/, ""));
}

test("a swapped stock shows its market value with the shares it stands for, and counts in the total", async () => {
  // 0.0025 INTC at $60 is $0.15; the total adds it to 19.990574 USDC.
  setup({ ...mainnetPortfolio(walletId, address), ownedAssets: [stock(intc, "2500000000000000")] });
  await open();
  expect(await screen.findByText("0.15 USD")).toBeVisible();
  expect(screen.getByText("0.0025 INTC")).toBeVisible();
  expect(screen.getByLabelText("20.140574 USD")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "INTC holding details" }));
  // The detail names the stock and leads with its price and shares, without chain internals.
  expect(screen.getByText("Intel")).toBeVisible();
  expect(screen.getByLabelText("Market price $60.00")).toBeVisible();
  expect(screen.queryByText(intc)).toBeNull();
  expect(screen.queryByText(/^Chain /)).toBeNull();
  expect(screen.queryByText(/Last checked/)).toBeNull();
  expect(screen.queryByText(/estimate/)).toBeNull();
  expect(screen.queryByText(/Your shares/i)).toBeNull();
});

test("a stock without a market price keeps its amount and no guessed value", async () => {
  setup({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [stock(googl, "5000000000000000000")],
  });
  await open();
  expect(await screen.findByText("5 GOOGL")).toBeVisible();
  expect(screen.getByLabelText("19.990574 USD")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "GOOGL holding details" }));
  expect(screen.getByLabelText("Market price unavailable")).toBeVisible();
});

test("assets are ordered by USD value, with unpriced holdings last", async () => {
  setup({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [
      stock(googl, "5000000000000000000"),
      stable(usdg, "USDG", "1000000"),
      // 0.1 INTC at $60 is $6, more than 1 USDG.
      stock(intc, "100000000000000000"),
    ],
  });
  await open();
  await screen.findByText("6 USD");
  expect(assetRows()).toEqual(["INTC", "USDG", "GOOGL"]);
});

test("Sell on a stock row opens Swap's sell form with that stock chosen", async () => {
  readHoldings.mockResolvedValue({
    checkedAt: 1,
    block: "0x1",
    holdings: [
      {
        token: googl,
        chainId: 4663,
        symbol: "GOOGL",
        decimals: 18,
        balanceAtoms: "5000000000000000000",
        batches: [],
      },
      {
        token: intc,
        chainId: 4663,
        symbol: "INTC",
        decimals: 18,
        balanceAtoms: "2500000000000000",
        batches: [],
      },
    ],
  });
  setup({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [stock(googl, "5000000000000000000"), stock(intc, "2500000000000000")],
  });
  await open();
  fireEvent.press(await screen.findByRole("button", { name: "INTC holding details" }));
  await userEvent.press(screen.getByRole("button", { name: "Sell INTC" }));
  expect(await screen.findByText("Available: 0.0025 INTC")).toBeVisible();
  expect(screen.queryByText(/Available: 5 GOOGL/)).toBeNull();
});

test("only stocks get a row shortcut; USDC and USDG rows add no duplicate actions", async () => {
  setup({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [
      stable("confidential:monad-usdc", "USDC (private)", "3000000", 143),
      stable(usdg, "USDG", "1000000"),
    ],
  });
  await open();
  fireEvent.press(await screen.findByRole("button", { name: "USDG holding details" }));
  fireEvent.press(screen.getByRole("button", { name: "USDC (private) holding details" }));
  expect(screen.queryByRole("button", { name: /^Sell / })).toBeNull();
  expect(screen.queryByRole("button", { name: "Receive USDC" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Withdraw USDC" })).toBeNull();
});

test("an empty portfolio invites a first stock instead of hiding Assets", async () => {
  setup({ ...mainnetPortfolio(walletId, address, "0"), ownedAssets: [], positions: [] });
  await open();
  const empty = await screen.findByText("No assets yet");
  expect(empty).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Buy a stock" }));
  expect(await screen.findByRole("button", { name: "Reverse direction" })).toBeVisible();
});

test("public USDC alone is not shown as an empty portfolio", async () => {
  setup({ ...mainnetPortfolio(walletId, address, "153834"), ownedAssets: [], positions: [] });
  await open();
  expect(await screen.findByRole("header", { name: "Earn" })).toBeVisible();
  expect(screen.queryByText("No assets yet")).toBeNull();
});

test("market value rounds down at the token's precision", () => {
  expect(marketValueAtoms("2500000000000000", 18, 60)).toBe("150000");
  expect(marketValueAtoms("21163707187261869", 18, 61.619999999959994)).toBe("1304107");
  expect(marketValueAtoms("1", 18, 60)).toBe("0");
});

test("valued stock rows retain private-read unlock and Earn without bringing back holdings tools", async () => {
  setup({
    ...mainnetPortfolio(walletId, address),
    confidentialReadState: "locked",
    ownedAssets: [stock(intc, "2500000000000000")],
  });
  await open();
  expect(await screen.findByText("0.15 USD")).toBeVisible();
  expect(screen.getByLabelText("20.140574 USD")).toBeVisible();
  expect(screen.getByRole("button", { name: "Unlock private balance" })).toBeVisible();
  expect(screen.getByRole("header", { name: "Earn" })).toBeVisible();
  expect(screen.queryByText("Holdings tools")).toBeNull();
  expect(readHoldings).not.toHaveBeenCalled();
});

test("a failed refresh preserves the priced stock total with main's quiet recovery controls", async () => {
  const { portfolio } = setup({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [stock(intc, "2500000000000000")],
  });
  await open();
  await screen.findByLabelText("20.140574 USD");
  portfolio.getMainnetPortfolio.mockRejectedValueOnce(new Error("private-provider-sentinel"));
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  expect(await screen.findByText("Showing your last known balance.")).toBeVisible();
  expect(screen.getByLabelText("20.140574 USD")).toBeVisible();
  expect(screen.getByText("0.15 USD")).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh balance" })).toBeEnabled();
  expect(screen.queryByText(/PORTFOLIO_READ_FAILED|private-provider-sentinel/)).toBeNull();
});
