import { openEarnLink } from "../../support/earnNavigation";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { act, fireEvent, render, screen, userEvent } from "@testing-library/react-native";
import { Linking, Platform, RefreshControl } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import { defaultPreferences } from "@/domain/preferences";
import { deferred } from "../../support/renderApp";
import { earnProfiles } from "@/domain/earn/types";
import { tokenCatalogService } from "@/services/tokenCatalog";

import { requireOptionalNativeModule } from "expo";

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));
const originalOS = Platform.OS;
const originalVersion = Platform.Version;
const readHoldings = jest.fn();
const capabilities = jest.fn();
const sellHolding = jest.fn();

const address = "0x" + "1".repeat(40);
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const state = {
  status: "ready",
  walletId,
  accounts: [{ accountIndex: 0, address, chainId: 10143 }],
};
beforeEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: "18.5" });
  sellHolding.mockReset().mockResolvedValue({ phase: "COMPLETE" });
  capabilities.mockReset().mockResolvedValue({
    contractVersion: 1,
    available: true,
    swaps: true,
    confidentialSaleProceeds: true,
  });
  readHoldings.mockReset().mockResolvedValue({ checkedAt: 1, block: "0x123", holdings: [] });
  jest.mocked(requireOptionalNativeModule).mockReturnValue({
    getCapabilities: capabilities,
    getSwapHoldings: readHoldings,
    sellSwapHolding: sellHolding,
  });
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener");
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  Object.defineProperty(Platform, "Version", { configurable: true, value: originalVersion });
});

function setup() {
  const native = {
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: address }),
    getWalletState: jest.fn().mockResolvedValue(state),
    openWallet: jest.fn().mockResolvedValue(state),
    createWallet: jest.fn(),
    backupWallet: jest.fn(),
    restoreWallet: jest.fn(),
    lock: jest.fn(),
  };
  const balance = { getBalance: jest.fn().mockResolvedValue("19990574") };
  const transfers = {
    history: jest.fn().mockResolvedValue({ entries: [], blocked: false }),
    send: jest.fn(),
    cancel: jest.fn(),
  };
  const portfolio = {
    getMainnetPortfolio: jest.fn().mockResolvedValue(mainnetPortfolio(walletId, address)),
  };
  const clipboard = { copy: jest.fn().mockResolvedValue(undefined) };
  render(
    <AppRoot
      mainnetPortfolioService={portfolio}
      accessService={createStoredWalletAccess(() => native)}
      walletBalanceService={balance}
      walletTransferService={transfers}
      opportunityService={{
        list: jest.fn().mockResolvedValue({ list: [], page: 0, items: 8, total: 0 }),
        detail: jest.fn(),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
      accountDependencies={{
        clipboard,
        store: {
          load: jest.fn().mockResolvedValue(defaultPreferences),
          save: jest.fn(),
          clear: jest.fn(),
        },
      }}
    />,
  );
  return { native, balance, portfolio, transfers, clipboard };
}
async function open() {
  await screen.findByRole("button", { name: "Unlock wallet" });
  await userEvent.press(screen.getByRole("button", { name: "Unlock wallet" }));
}

test("Home combines vault value with liquid USDC and shows one named vault position", async () => {
  const { portfolio } = setup();
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [],
    positions: [
      {
        assetId: `4663:${earnProfiles["robinhood-usdg"].vault.toLowerCase()}`,
        chainId: 4663,
        token: earnProfiles["robinhood-usdg"].vault,
        symbol: "USDG",
        decimals: 6,
        balanceAtoms: "3000000000000",
        observedAtoms: "3000000000000",
        shareAtoms: "3000000000000",
        shareDecimals: 18,
        underlyingAtoms: "3000000",
        observedUnderlyingAtoms: "3000000",
        valueUsdcAtoms: "3000000",
        complete: true,
        stale: false,
        checkedAt: Date.now(),
        valuationUnavailable: false,
        conversionEstimated: true,
      },
    ],
    ownedBalanceComplete: true,
  });
  await open();
  expect(await screen.findByLabelText("22.990574 USD")).toBeVisible();
  expect(screen.getAllByText("Steakhouse USDG")).toHaveLength(1);
  expect(screen.getByText("3 USDG deposited")).toBeVisible();
  expect(screen.getByRole("button", { name: "View Steakhouse USDG position" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Tokens and vault positions" })).toBeNull();
  await openEarnLink();
  expect(await screen.findByText("Source balance: 19.990574 USDC")).toBeVisible();
});

test("mainnet Home and Earn share the native portfolio without another source RPC", async () => {
  const { portfolio, balance, transfers } = setup();
  await open();
  expect(await screen.findByLabelText("19.990574 USD")).toBeVisible();
  await openEarnLink();
  expect(await screen.findByText("Source balance: 19.990574 USDC")).toBeVisible();
  expect(portfolio.getMainnetPortfolio).toHaveBeenCalled();
  expect(balance.getBalance).not.toHaveBeenCalled();
  expect(transfers.history).not.toHaveBeenCalled();
});

test("mainnet deposit keeps the explicit USDC receiving address", async () => {
  const { clipboard } = setup();
  await open();
  await screen.findByLabelText("19.990574 USD");
  await userEvent.press(screen.getByRole("button", { name: "Receive" }));
  expect(await screen.findByRole("header", { name: "Receive" })).toBeVisible();
  expect(
    screen.getByText("Swap funding address · Receive USDC on Monad mainnet only."),
  ).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  expect(clipboard.copy).toHaveBeenCalledWith(address);
});

test("USDC withdrawal never calls the testnet transfer signer", async () => {
  const { transfers } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Send" }));
  expect(await screen.findByText(/Sending USDC directly is not available yet/)).toBeVisible();
  expect(transfers.send).not.toHaveBeenCalled();
  expect(transfers.history).not.toHaveBeenCalled();
});

test("failed native portfolio refresh preserves the prior balance until a fresh snapshot", async () => {
  const { portfolio } = setup();
  await open();
  await screen.findByLabelText("19.990574 USD");
  portfolio.getMainnetPortfolio.mockRejectedValueOnce(new Error("secret-sentinel provider error"));
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  expect(await screen.findByText(/Previously loaded balances may be stale/)).toBeVisible();
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Error details", expanded: false }));
  expect(screen.getByText("Code: PORTFOLIO_READ_FAILED")).toBeVisible();
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  expect(screen.getByLabelText("19.990574 USD")).toBeVisible();
  portfolio.getMainnetPortfolio.mockResolvedValue(mainnetPortfolio(walletId, address, "0"));
  fireEvent.press(screen.getByRole("button", { name: "Retry balance" }));
  expect(await screen.findByLabelText("0 USD")).toBeVisible();
});

test("disconnect ignores late native snapshots from the previous session", async () => {
  const { portfolio, native } = setup();
  const pending = deferred<import("@/domain/wallet/storedSigner").MainnetPortfolioSnapshot>();
  portfolio.getMainnetPortfolio.mockReturnValueOnce(pending.promise);
  await open();
  await screen.findByLabelText("Loading your balance");
  await userEvent.press(screen.getByLabelText("Settings tab"));
  await userEvent.press(await screen.findByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Unlock wallet" });
  portfolio.getMainnetPortfolio.mockResolvedValue(mainnetPortfolio(walletId, address, "0"));
  await open();
  expect(await screen.findByLabelText("0 USD")).toBeVisible();
  await act(async () => pending.resolve(mainnetPortfolio(walletId, address, "1000000")));
  expect(screen.queryByLabelText("1 USD")).toBeNull();
  expect(native.lock).toHaveBeenCalled();
});

test("a settled incomplete native cache is retryable and never exposes zero as spendable", async () => {
  const { portfolio } = setup();
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address, "0"),
    balanceComplete: false,
    stale: true,
    syncPending: true,
  });
  await open();
  expect(await screen.findByRole("button", { name: "Retry balance" })).toBeVisible();
  expect(screen.queryByLabelText("Loading your balance")).toBeNull();
  expect(screen.queryByLabelText("0 USD")).toBeNull();
  await openEarnLink();
  expect(
    await screen.findByText("Your balance will be checked during deposit review."),
  ).toBeVisible();
  expect(screen.queryByText("Checking source balance…")).toBeNull();
});

test("owned token amounts and vault underlying values remain distinct when market prices are unavailable", async () => {
  const { portfolio } = setup();
  const weth = {
    assetId: "eth:weth",
    chainId: 1,
    token: "0x" + "6".repeat(40),
    symbol: "WETH",
    decimals: 18,
    balanceAtoms: "500000000000000000",
    observedAtoms: "500000000000000000",
    complete: true,
    stale: false,
    checkedAt: Date.now(),
    valueUsdcAtoms: null,
    valuationUnavailable: true,
  };
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [
      weth,
      {
        ...weth,
        assetId: "hood:unknown",
        symbol: "NEW",
        decimals: null,
        balanceAtoms: null,
        observedAtoms: "0",
        complete: false,
        valuationUnavailable: false,
      },
    ],
    positions: [
      {
        ...weth,
        assetId: "eth:pendle",
        token: "0x" + "7".repeat(40),
        symbol: "USDC",
        decimals: 6,
        balanceAtoms: "2000000",
        observedAtoms: "2000000",
        shareDecimals: 18,
        conversionEstimated: true,
        shareAtoms: "1000000000000000000",
        underlyingAtoms: "2000000",
        valueUsdcAtoms: "2000000",
        valuationUnavailable: false,
      },
    ],
    ownedBalanceComplete: false,
    valuationComplete: false,
  });
  await open();
  expect(await screen.findByText("Your vaults")).toBeVisible();
  expect(screen.queryByText("Checking owned token balances and positions…")).toBeNull();
  expect(await screen.findByText("0.5 WETH")).toBeVisible();
  expect(screen.getByText("2 USD")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "USDC position details" }));
  expect(screen.getByText("Vault position")).toBeVisible();
  expect(screen.getByText("Estimated underlying: 2 USDC")).toBeVisible();
  expect(screen.queryByText("USD value unavailable.")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "WETH holding details", expanded: false }));
  expect(screen.getByText("USD value unavailable.")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "NEW holding details" }));
  expect(screen.getByText("NEW balance unavailable. Refresh to retry.")).toBeVisible();
  expect(screen.queryByText("Checking NEW balance…")).toBeNull();
  expect(screen.queryByText("Some balances or asset values are unavailable.")).toBeNull();
  expect(screen.getByLabelText("21.990574 USD")).toBeVisible();
});

test("partial vault observations use underlying units and never relabel shares as USDC", async () => {
  const { portfolio } = setup();
  const position = {
    assetId: "eth:partial-vault",
    chainId: 1,
    token: "0x" + "7".repeat(40),
    symbol: "USDC",
    decimals: 6,
    balanceAtoms: null,
    observedAtoms: "1000000000000000000",
    shareAtoms: null,
    shareDecimals: 18,
    underlyingAtoms: null,
    observedUnderlyingAtoms: "2000000",
    conversionEstimated: true,
    complete: false,
    stale: true,
    checkedAt: Date.now(),
    valueUsdcAtoms: null,
    valuationUnavailable: false,
  };
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    positions: [
      position,
      {
        ...position,
        assetId: "hood:partial-vault",
        symbol: "USDG",
        chainId: 4663,
        observedUnderlyingAtoms: null,
      },
    ],
    ownedBalanceComplete: false,
  });
  await open();
  fireEvent.press(
    await screen.findByRole("button", { name: "USDC position details", expanded: false }),
  );
  expect(screen.getByText("Estimated underlying: 2 USDC")).toBeVisible();
  expect(screen.queryByText("USDC balance unavailable. Refresh to retry.")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "USDG position details" }));
  expect(screen.getByText("USDG balance unavailable. Refresh to retry.")).toBeVisible();
  expect(screen.queryByText(/Previously observed: .*USDG/)).toBeNull();
  expect(screen.queryByText(/1,?000,?000,?000,?000 (USDC|USDG)/)).toBeNull();
  expect(screen.getByLabelText("19.990574 USD")).toBeVisible();
});

test.each(["ios", "android"])(
  "%s Home shows Earn vaults alongside swapped stocks without swap holdings tools",
  async (os) => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    Object.defineProperty(Platform, "Version", {
      configurable: true,
      value: os === "ios" ? "18.5" : 35,
    });
    readHoldings.mockResolvedValue({
      checkedAt: 1,
      block: "0x123",
      holdings: [
        {
          token: "0x" + "ab".repeat(20),
          chainId: 4663,
          symbol: "GOOGL",
          decimals: 6,
          balanceAtoms: "1234500",
          batches: [],
        },
      ],
    });
    setup();
    await open();
    expect(await screen.findByRole("header", { name: "Earn" })).toBeVisible();
    expect(screen.queryByText("1.2345 GOOGL")).toBeNull();
    expect(screen.queryByText("Holdings tools")).toBeNull();
    expect(screen.queryByRole("button", { name: "Wallet details" })).toBeNull();
    // Selling swapped stocks lives in Swap; Home no longer reads swap holdings.
    expect(readHoldings).not.toHaveBeenCalled();
  },
);

test("Home always offers Earn vaults", async () => {
  setup();
  await open();
  expect(await screen.findByRole("header", { name: "Earn" })).toBeVisible();
  expect(screen.queryByText("Holdings")).toBeNull();
  expect(screen.queryByRole("button", { name: "Wallet details" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "See all vaults" }));
  expect(await screen.findByLabelText("vaults list")).toBeVisible();
});

test("Activity has a simple empty state and pull-to-refresh with retry on failure", async () => {
  const { portfolio } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "View activity" }));
  expect(await screen.findByText("No activity yet")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Refresh balance" })).toBeNull();
  portfolio.getMainnetPortfolio.mockRejectedValueOnce(new Error("secret-sentinel"));
  fireEvent(screen.UNSAFE_getAllByType(RefreshControl).at(-1)!, "refresh");
  expect(
    await screen.findByText("Couldn’t refresh activity. Showing saved activity."),
  ).toBeVisible();
  expect(screen.queryByText("No activity yet")).toBeNull();
  expect(screen.queryByText(/secret-sentinel/)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Retry activity" }));
  expect(await screen.findByText("No activity yet")).toBeVisible();
});

test("Swap Max fills the available USDC amount with exact decimal precision", async () => {
  setup();
  await open();
  await screen.findByLabelText("19.990574 USD");
  await userEvent.press(screen.getByLabelText("Swap tab"));
  await userEvent.press(await screen.findByRole("button", { name: "Use maximum USDC amount" }));
  expect(screen.getByLabelText("Amount in USDC")).toHaveProp("value", "19.990574");
});

test("returning to Home reuses balances without refreshing portfolio or token holdings", async () => {
  const { portfolio } = setup();
  await open();
  await screen.findByLabelText("19.990574 USD");
  await screen.findByRole("header", { name: "Earn" });
  const balanceReads = portfolio.getMainnetPortfolio.mock.calls.length;
  const holdingReads = readHoldings.mock.calls.length;
  await userEvent.press(screen.getByLabelText("Settings tab"));
  await userEvent.press(screen.getByLabelText("Home tab"));
  expect(await screen.findByLabelText("19.990574 USD")).toBeVisible();
  expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(balanceReads);
  expect(readHoldings).toHaveBeenCalledTimes(holdingReads);
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  await act(async () => {});
  expect(portfolio.getMainnetPortfolio).toHaveBeenCalledTimes(balanceReads + 1);
});

test("Home shows aggregate USDG once and leaves selling swapped tokens to Swap", async () => {
  const { portfolio } = setup();
  const token = "0x" + "ab".repeat(20);
  const asset = {
    assetId: `4663:${token}`,
    chainId: 4663,
    token,
    symbol: "USDG",
    decimals: 6,
    balanceAtoms: "10000000",
    observedAtoms: "10000000",
    complete: true,
    stale: false,
    checkedAt: Date.now(),
    valueUsdcAtoms: null,
    valuationUnavailable: true,
  };
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    // The owned USDG aggregate includes Earn wallets as well as swapped tokens.
    ownedAssets: [
      asset,
      { ...asset, assetId: "1:other", chainId: 1, token: "0x" + "ef".repeat(20), symbol: "GOOGL" },
    ],
    positions: [
      {
        ...asset,
        assetId: "4663:vault",
        token: "0x" + "cd".repeat(20),
        balanceAtoms: "20000000",
        shareAtoms: "20000000",
        underlyingAtoms: "20000000",
      },
    ],
  });
  readHoldings.mockResolvedValue({
    checkedAt: 1,
    block: "0x123",
    holdings: [
      {
        token,
        chainId: 4663,
        symbol: "USDG",
        decimals: 6,
        balanceAtoms: "1234500",
        batches: [{ id: `${token}:6`, balanceAtoms: "1234500" }],
      },
      {
        token: "0x" + "ef".repeat(20),
        chainId: 4663,
        symbol: "GOOGL",
        decimals: 6,
        balanceAtoms: "5000000",
        batches: [],
      },
    ],
  });
  await open();
  expect(await screen.findByText("10 USDG")).toBeVisible();
  expect(screen.getByText("20 USDG")).toBeVisible();
  expect(screen.queryByText("1.2345 USDG")).toBeNull();
  expect(screen.queryByRole("button", { name: "USDG swap tools" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Swap USDG to USDC" })).toBeNull();
  expect(readHoldings).not.toHaveBeenCalled();
  expect(sellHolding).not.toHaveBeenCalled();
});

test("private USDC retains its observed amount while refreshing a partial observation", async () => {
  const { portfolio } = setup();
  const asset = {
    assetId: "nep245:private-usdc",
    chainId: 143,
    token: "nep245:private-usdc",
    symbol: "USDC",
    decimals: 6,
    balanceAtoms: null,
    observedAtoms: "2500000",
    complete: false,
    stale: true,
    checkedAt: 1,
    valueUsdcAtoms: null,
    valuationUnavailable: true,
  };
  const partial = {
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [asset],
    ownedBalanceComplete: false,
  };
  portfolio.getMainnetPortfolio.mockResolvedValue(partial);
  await open();
  expect(await screen.findByText("2.5 USDC")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "USDC holding details" }));
  expect(screen.queryByText(/Previously observed|Previously checked/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "USDC holding details" }));
  expect(screen.queryByText("Checking USDC balance…")).toBeNull();
  const pending = deferred<import("@/domain/wallet/storedSigner").MainnetPortfolioSnapshot>();
  portfolio.getMainnetPortfolio.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole("button", { name: "Retry token balances and positions" }));
  expect(screen.getByText("2.5 USDC")).toBeVisible();
  expect(screen.queryByText("Checking USDC balance…")).toBeNull();
  expect(screen.queryByText("USDC balance unavailable. Refresh to retry.")).toBeNull();
  await act(async () =>
    pending.resolve({
      ...partial,
      ownedBalanceComplete: true,
      ownedAssets: [{ ...asset, complete: true, stale: false, balanceAtoms: "2500000" }],
    }),
  );
  expect(await screen.findByText("2.5 USDC")).toBeVisible();
  expect(screen.queryByText("Checking USDC balance…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry token balances and positions" })).toBeNull();
});

test("an unavailable swapped token balance says so on Home without a swap wallet card", async () => {
  const { portfolio } = setup();
  const token = "0x" + "ab".repeat(20);
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    ownedBalanceComplete: false,
    ownedAssets: [
      {
        assetId: `4663:${token}`,
        chainId: 4663,
        token,
        symbol: "USDG",
        decimals: 6,
        balanceAtoms: null,
        observedAtoms: "0",
        complete: false,
        stale: true,
        checkedAt: 0,
        valueUsdcAtoms: null,
        valuationUnavailable: true,
      },
    ],
  });
  readHoldings.mockResolvedValue({
    checkedAt: 1,
    block: "0x123",
    holdings: [
      { token, chainId: 4663, symbol: "USDG", decimals: 6, balanceAtoms: "1234500", batches: [] },
    ],
  });
  await open();
  fireEvent.press(await screen.findByRole("button", { name: "USDG holding details" }));
  expect(screen.queryByText("1.2345 USDG")).toBeNull();
  expect(screen.queryByText("Swap receiving wallets")).toBeNull();
  expect(screen.getByText("USDG balance unavailable. Refresh to retry.")).toBeVisible();
  expect(screen.queryByText("0 USDG")).toBeNull();
});

const intc = "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681";
function boughtStock() {
  return {
    ...mainnetPortfolio(walletId, address),
    ownedAssets: [
      {
        assetId: `4663:${intc}`,
        chainId: 4663,
        token: intc,
        symbol: "Token c39681",
        decimals: null,
        balanceAtoms: "2500000000000000",
        observedAtoms: "2500000000000000",
        complete: true,
        stale: false,
        checkedAt: 1,
        valueUsdcAtoms: null,
        valuationUnavailable: true,
      },
    ],
  };
}

test("a stock bought with Swap shows its catalog name and logo instead of its address", async () => {
  const list = jest.spyOn(tokenCatalogService, "list").mockResolvedValue({
    list: [
      {
        chainId: 4663,
        address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
        symbol: "INTC",
        name: "Intel • Robinhood Token",
        decimals: 18,
        logoURI: "https://example.com/intc.png",
        category: "rwa",
        issuer: "Robinhood",
        swapListed: true,
        fusionStatus: "quote-required",
      },
    ],
    page: 0,
    items: 20,
    total: 1,
  });
  const { portfolio } = setup();
  portfolio.getMainnetPortfolio.mockResolvedValue(boughtStock());
  await open();
  const row = await screen.findByRole("button", { name: "INTC holding details" });
  expect(screen.getByLabelText("INTC logo")).toBeVisible();
  expect(screen.getByText("0.0025 INTC")).toBeVisible();
  expect(screen.queryByText(/Token c39681/)).toBeNull();
  fireEvent.press(row);
  expect(screen.getByText("Intel")).toBeVisible();
  expect(list).toHaveBeenCalledWith(
    { chainId: 4663, category: "all", search: intc, page: 0 },
    expect.anything(),
  );
});

test("a stock the catalog cannot name keeps its native label and the rest of Home", async () => {
  jest.spyOn(tokenCatalogService, "list").mockRejectedValue(new Error("offline"));
  const { portfolio } = setup();
  portfolio.getMainnetPortfolio.mockResolvedValue(boughtStock());
  await open();
  expect(await screen.findByRole("button", { name: "Token c39681 holding details" })).toBeVisible();
  expect(screen.getByLabelText("Token c39681 logo unavailable")).toBeVisible();
});

test("a locked private balance explains wallet unlock without claiming a provider outage", async () => {
  const { portfolio } = setup();
  portfolio.getMainnetPortfolio.mockResolvedValue({
    ...mainnetPortfolio(walletId, address),
    confidentialReadState: "locked",
    ownedBalanceComplete: false,
    ownedAssets: [
      {
        assetId: "nep245:private-usdc",
        chainId: 143,
        token: "confidential:monad-usdc",
        symbol: "USDC (private)",
        decimals: 6,
        balanceAtoms: null,
        observedAtoms: "0",
        complete: false,
        stale: true,
        checkedAt: 0,
        valueUsdcAtoms: null,
        valuationUnavailable: true,
      },
    ],
  });
  await open();
  expect(screen.getByRole("button", { name: "Refresh private balance" })).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "USDC (private) holding details" }));
  expect(screen.getByText("Refresh to check your private USDC.")).toBeVisible();
  expect(screen.queryByText("USDC (private) balance unavailable. Refresh to retry.")).toBeNull();
  expect(screen.queryByText("Checking USDC (private) balance…")).toBeNull();
  expect(screen.queryByText("0 USDC (private)")).toBeNull();
  expect(screen.getByLabelText("19.990574 USD")).toBeVisible();
});
