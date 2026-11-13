import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, RefreshControl } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import * as nativeBridge from "@/services/wallet/nativeBridge";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { validateMainnetPortfolio } from "@/features/wallet/MainnetWalletProvider";
import portfolioFixtures from "../../../modules/gizu-stored-signer/ios/Tests/Fixtures/public-portfolio.json";
import { deferred } from "../../support/renderApp";
import { earnProfiles } from "@/domain/earn/types";

const funding = "0x" + "1".repeat(40);
const returned = "0x" + "2".repeat(40);
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const snapshot: MainnetPortfolioSnapshot = {
  walletId,
  chainId: 143,
  asset: "USDC",
  decimals: 6,
  fundingAddress: funding,
  fundingAtoms: "500000",
  returnAtoms: "2500000",
  totalAtoms: "3000000",
  checkedAt: 1_790_000_000_000,
  block: "0x123",
  accounts: [
    { address: funding, role: "funding", accountIndex: 1, balanceAtoms: "500000" },
    { address: returned, role: "receiving", accountIndex: 9, balanceAtoms: "2500000" },
  ],
  history: [
    {
      operationId: "sell-1",
      phase: "COMPLETE",
      direction: "sell",
      symbol: "GOOGL",
      receivedAtoms: "2500000",
      recordedAt: 1_790_000_000_000,
    },
  ],
};
async function open(value: MainnetPortfolioSnapshot = snapshot) {
  const read = jest.fn().mockResolvedValue(value);
  const transfers = jest.spyOn(nativeBridge, "getStoredTransferSigner");
  jest
    .spyOn(nativeBridge, "getStoredSwapSigner")
    .mockReturnValue({ getMainnetPortfolio: read } as unknown as NonNullable<
      ReturnType<typeof nativeBridge.getStoredSwapSigner>
    >);
  render(
    <AppRoot
      mainnetPortfolioService={{ getMainnetPortfolio: read }}
      accessService={{
        method: "Passkey",
        request: async () => ({
          kind: "mainnet",
          method: "Passkey",
          accountId: funding,
          address: funding,
          accountIndex: 1,
          chainId: 143,
          walletId,
        }),
      }}
    />,
  );
  await screen.findByRole("button", { name: "Continue with passkey" });
  fireEvent.press(await screen.findByRole("button", { name: "Continue with passkey" }));
  await screen.findByRole("button", { name: "Balance details" });
  return { read, transfers };
}
afterEach(() => jest.restoreAllMocks());

test("an asset is one logo/value row and tapping it reveals the holding details", async () => {
  await open({
    ...snapshot,
    ownedAssets: [
      {
        assetId: "private",
        chainId: 143,
        token: "confidential:monad-usdc",
        symbol: "USDC (private)",
        decimals: 6,
        balanceAtoms: null,
        observedAtoms: "2430000",
        complete: false,
        stale: true,
        checkedAt: snapshot.checkedAt,
        valueUsdcAtoms: null,
        valuationUnavailable: true,
      },
      {
        assetId: "143:native",
        chainId: 143,
        token: "native",
        symbol: "MON",
        decimals: 18,
        balanceAtoms: "1",
        observedAtoms: "1",
        complete: true,
        stale: false,
        checkedAt: snapshot.checkedAt,
        valueUsdcAtoms: null,
        valuationUnavailable: true,
      },
    ],
  });
  expect(screen.getByLabelText("USDC (private) logo")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "USDC (private) holding details", expanded: false }),
  ).toBeVisible();
  expect(screen.queryByText("2.43 USDC (private)")).toBeNull();
  expect(
    screen.queryByText(/Value:|Holding details|Some balances or asset values are unavailable/),
  ).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "USDC (private) holding details" }));
  expect(screen.getByText("2.43 USDC (private)")).toBeVisible();
  expect(screen.getByText("Chain 143")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "USDC (private) holding details" }));
  expect(screen.queryByText("Chain 143")).toBeNull();
});

test("Home can unlock an expired private read and refresh the authenticated private amount", async () => {
  const privateAsset = {
    assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
    chainId: 143,
    token: "confidential:monad-usdc",
    symbol: "USDC (private)",
    decimals: 6,
    balanceAtoms: null,
    observedAtoms: "2000000",
    valueUsdcAtoms: null,
    valuationUnavailable: true,
    complete: false,
    stale: true,
    checkedAt: snapshot.checkedAt,
  };
  const unlock = jest.fn().mockResolvedValue({ status: "ready", walletId, accounts: [] });
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: unlock,
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  const { read, transfers } = await open({
    ...snapshot,
    confidentialReadState: "locked",
    ownedAssets: [privateAsset],
  });
  expect(screen.getByText("2 USD")).toBeVisible();
  expect(screen.getByLabelText("5 USD")).toBeVisible();
  expect(screen.queryByText(/Previously checked|Previously observed/)).toBeNull();
  read.mockResolvedValue({
    ...snapshot,
    confidentialReadState: "ready",
    ownedAssets: [
      {
        ...privateAsset,
        complete: true,
        stale: false,
        balanceAtoms: "2500000",
        observedAtoms: "2500000",
        valueUsdcAtoms: "2500000",
        valuationUnavailable: false,
      },
    ],
  });
  fireEvent.press(screen.getByRole("button", { name: "Unlock private balance" }));
  expect(await screen.findByText("2.5 USD")).toBeVisible();
  expect(screen.getByLabelText("5.5 USD")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Unlock private balance" })).toBeNull();
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(transfers).not.toHaveBeenCalled();
});

test("Home includes public USDC, observed private USDC and unpriced USDG in one USD total", async () => {
  const row = {
    assetId: "usdg",
    chainId: 4663,
    token: earnProfiles["robinhood-usdg"].token,
    symbol: "USDG",
    decimals: 6,
    balanceAtoms: "150000",
    observedAtoms: "150000",
    valueUsdcAtoms: null,
    valuationUnavailable: true,
    complete: true,
    stale: false,
    checkedAt: snapshot.checkedAt,
  };
  const { read } = await open({
    ...snapshot,
    fundingAtoms: "90000",
    returnAtoms: "0",
    totalAtoms: "90000",
    accounts: [{ ...snapshot.accounts[0]!, balanceAtoms: "90000" }],
    confidentialReadState: "locked",
    ownedAssets: [
      row,
      {
        ...row,
        assetId: "private-usdc",
        chainId: 143,
        token: "confidential:monad-usdc",
        symbol: "USDC (private)",
        balanceAtoms: null,
        observedAtoms: "2430000",
        complete: false,
        stale: true,
      },
    ],
  });
  expect(await screen.findByLabelText("2.67 USD")).toBeVisible();
  expect(screen.getByText("0.15 USD")).toBeVisible();
  expect(screen.getByText("2.43 USD")).toBeVisible();
  expect(
    screen.queryByText(/Previously checked|Previously observed|cached observation/i),
  ).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details" }));
  expect(screen.getByText("Other assets: 2.58 USD")).toBeVisible();
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  await act(async () => {});
  expect(screen.getByLabelText("2.67 USD")).toBeVisible();
  expect(read.mock.calls.length).toBeGreaterThan(1);
});

test("private unlock stays disabled during authentication and rejects another wallet", async () => {
  const pending = deferred<import("@/domain/wallet/storedSigner").StoredWalletState>();
  const unlock = jest.fn().mockReturnValue(pending.promise);
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: unlock,
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  const { read } = await open({ ...snapshot, confidentialReadState: "locked", ownedAssets: [] });
  const readsBefore = read.mock.calls.length;
  fireEvent.press(screen.getByRole("button", { name: "Unlock private balance" }));
  expect(screen.getByRole("button", { name: "Unlock private balance" })).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Unlock private balance" }));
  await act(async () =>
    pending.resolve({ status: "ready", walletId: "another-wallet", accounts: [] }),
  );
  expect(
    await screen.findByText("Wallet changed. Sign in again before checking private balances."),
  ).toBeVisible();
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(readsBefore);
  expect(screen.getByLabelText("3 USD")).toBeVisible();
});

test("a declined private balance unlock preserves cached amounts and allows a retry", async () => {
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: jest.fn().mockRejectedValue(new Error("Wallet unlock cancelled.")),
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  await open({ ...snapshot, confidentialReadState: "locked", ownedAssets: [] });
  fireEvent.press(screen.getByRole("button", { name: "Unlock private balance" }));
  expect(await screen.findByText("Wallet unlock cancelled.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Unlock private balance" })).toBeEnabled();
  expect(screen.getByLabelText("3 USD")).toBeVisible();
});

test("shared Rust, Swift and Kotlin fixtures satisfy the Home contract", () => {
  for (const fixture of portfolioFixtures.cases) {
    const value = { ...fixture.expected, history: [] } as MainnetPortfolioSnapshot;
    expect(validateMainnetPortfolio(value, "portfolio-fixture")).toBe(value);
  }
});

test("mainnet Home includes receiving USDC, Deposit uses funding address, Withdraw never signs", async () => {
  const { transfers } = await open();
  expect(screen.getByLabelText("3 USD")).toBeVisible();
  expect(screen.queryByText("Funding: 0.5 USDC")).toBeNull();
  expect(screen.queryByText("USDC accounts")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: false }));
  expect(screen.getByText("Funding: 0.5 USDC")).toBeVisible();
  expect(screen.getByText("Receiving wallets: 2.5 USDC")).toBeVisible();
  expect(screen.queryByText("USDC accounts")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: true }));
  expect(screen.queryByText("Funding: 0.5 USDC")).toBeNull();
  expect(screen.getByLabelText("3 USD")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Wallet details" })).toBeNull();
  expect(screen.queryByText(/testnet MON/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Receive" }));
  expect(
    await screen.findByText("Funding address · Receive USDC on Monad mainnet only."),
  ).toBeVisible();
  expect(screen.getByLabelText(`Account address: ${funding}`)).toBeVisible();
  expect(screen.queryByText("USDC accounts")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Wallet details", expanded: false }));
  expect(screen.getByText("USDC accounts")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy funding address" })).toBeVisible();

  fireEvent.press(screen.getByRole("button", { name: "Back" }));
  fireEvent.press(await screen.findByRole("button", { name: "Send" }));
  expect(await screen.findByText(/Sending USDC directly is not available/)).toBeVisible();
  expect(screen.queryByLabelText("Amount in MON")).toBeNull();
  expect(screen.queryByRole("button", { name: /Review send/ })).toBeNull();
  expect(transfers).not.toHaveBeenCalled();
});

test("Activity displays completed sale proceeds and no testnet transfer journal", async () => {
  await open();
  fireEvent.press(screen.getByRole("button", { name: "View activity" }));
  expect(await screen.findByText("GOOGL → USDC")).toBeVisible();
  expect(screen.getByText("Returned 2.5 USDC on Monad")).toBeVisible();
  expect(screen.queryByText(/Monad testnet/)).toBeNull();
});
test("Home opens the separate confidential cashout route without starting a transfer", async () => {
  const { transfers } = await open();
  fireEvent.press(screen.getByRole("button", { name: "Withdraw from Gizu" }));
  expect(await screen.findByText("Confidential cash")).toBeVisible();
  expect(
    screen.getByText(
      "Incoming and existing public USDC are not used. Native review verifies fresh private balances and any reserved funds.",
    ),
  ).toBeVisible();
  expect(transfers).not.toHaveBeenCalled();
});

test("Activity distinguishes privately credited sales from legacy public proceeds", async () => {
  await open({
    ...snapshot,
    history: [
      {
        ...snapshot.history[0]!,
        completionTarget: "confidential",
        privateCreditedAtoms: "2500000",
      },
    ],
  });
  fireEvent.press(screen.getByRole("button", { name: "View activity" }));
  expect(await screen.findByText("Credited 2.5 USDC to confidential cash")).toBeVisible();
  expect(screen.queryByText("Returned 2.5 USDC on Monad")).toBeNull();
});
test("private sale history requires a completed sale and the same verified private received amount", () => {
  const privateSale = {
    ...snapshot.history[0]!,
    completionTarget: "confidential" as const,
    privateCreditedAtoms: "2500000",
  };
  expect(validateMainnetPortfolio({ ...snapshot, history: [privateSale] }, walletId)).toBeDefined();
  expect(
    validateMainnetPortfolio(
      {
        ...snapshot,
        history: [
          { ...privateSale, phase: "CANCELLED", privateCreditedAtoms: "0", receivedAtoms: "0" },
        ],
      },
      walletId,
    ),
  ).toBeDefined();
  for (const change of [
    { privateCreditedAtoms: undefined },
    { privateCreditedAtoms: "0" },
    { privateCreditedAtoms: "0.5" },
    { privateCreditedAtoms: "2400000" },
    { direction: "buy" },
    { phase: "PAUSED" },
    { completionTarget: "unknown" },
  ])
    expect(() =>
      validateMainnetPortfolio(
        { ...snapshot, history: [{ ...privateSale, ...change }] } as MainnetPortfolioSnapshot,
        walletId,
      ),
    ).toThrow();
});

test("rejects cross-wallet/network snapshots, inconsistent sums and duplicate accounts", () => {
  expect(validateMainnetPortfolio(snapshot, walletId)).toBe(snapshot);
  for (const invalid of [
    { ...snapshot, walletId: "other" },
    { ...snapshot, chainId: 10143 },
    { ...snapshot, totalAtoms: "999" },
    { ...snapshot, fundingAtoms: "0.5" },
    { ...snapshot, accounts: [snapshot.accounts[0], snapshot.accounts[0]] },
  ])
    expect(() => validateMainnetPortfolio(invalid as MainnetPortfolioSnapshot, walletId)).toThrow();
});

test("Swap shows the same total public USDC funding balance including receiving accounts", async () => {
  await open();
  await screen.findByLabelText("3 USD");
  fireEvent.press(screen.getByLabelText("Swap tab"));
  expect(await screen.findByText("Available: 3 USDC")).toBeVisible();
  expect(screen.getByLabelText("Amount in USDC")).toBeVisible();
  expect(screen.queryByText(/maximum 10 USDC/)).toBeNull();
});

test("Home balance shows observed performance and expands to a period chart", async () => {
  const day = 24 * 3_600_000;
  await AsyncStorage.setItem(
    `gizu:balance-history:v1:${encodeURIComponent(`${walletId}:portfolio-usd-v1`)}`,
    JSON.stringify([{ at: snapshot.checkedAt - 20 * day, atoms: "2000000" }]),
  );
  await open();
  expect(await screen.findByText("+$1.00 (+50%) · past month")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: false }));
  expect(screen.getByLabelText("Balance past month: +$1.00 (+50%)")).toBeVisible();
  fireEvent.press(screen.getByRole("radio", { name: "1W" }));
  expect(screen.getByLabelText("Balance history is not available yet")).toBeVisible();
  expect(screen.queryByText(/past week/)).toBeNull();
  fireEvent.press(screen.getByRole("radio", { name: "1Y" }));
  expect(screen.getByRole("radio", { name: "1Y", checked: true })).toBeVisible();
  expect(screen.getByLabelText("Balance past year: +$1.00 (+50%)")).toBeVisible();
});

test("Home does not compare USD portfolio value against older USDC or liquid-only history", async () => {
  await AsyncStorage.setItem(
    `gizu:balance-history:v1:${walletId}`,
    JSON.stringify([{ at: snapshot.checkedAt - 20 * 24 * 3_600_000, atoms: "2000000" }]),
  );
  await AsyncStorage.setItem(
    `gizu:balance-history:v1:${encodeURIComponent(`${walletId}:portfolio-value-v1`)}`,
    JSON.stringify([{ at: snapshot.checkedAt - 20 * 24 * 3_600_000, atoms: "2000000" }]),
  );
  await open();
  expect(screen.queryByText("+$1.00 (+50%) · past month")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: false }));
  expect(screen.getByLabelText("Balance history is not available yet")).toBeVisible();
});

test("returning from app switching refreshes private balances without another unlock", async () => {
  const unlock = jest.fn();
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: unlock,
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  const { read } = await open({ ...snapshot, confidentialReadState: "ready", ownedAssets: [] });
  const callbacks = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, callback]) => callback);
  const readsBefore = read.mock.calls.length;
  act(() => callbacks.forEach((callback) => callback("background")));
  read.mockResolvedValue({
    ...snapshot,
    confidentialReadState: "ready",
    fundingAtoms: "600000",
    totalAtoms: "3100000",
    accounts: [{ ...snapshot.accounts[0]!, balanceAtoms: "600000" }, snapshot.accounts[1]!],
  });
  await act(async () => callbacks.forEach((callback) => callback("active")));
  expect(await screen.findByLabelText("3.1 USD")).toBeVisible();
  expect(read.mock.calls.length).toBeGreaterThan(readsBefore);
  expect(unlock).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Unlock private balance" })).toBeNull();
});

test("a balance read interrupted by backgrounding cannot overwrite the foreground refresh", async () => {
  const pending = deferred<MainnetPortfolioSnapshot>();
  const { read } = await open({ ...snapshot, confidentialReadState: "ready" });
  await act(async () => {});
  const initialReads = read.mock.calls.length;
  read.mockReturnValueOnce(pending.promise);
  fireEvent(screen.UNSAFE_getByType(RefreshControl), "refresh");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(initialReads + 1));
  const callbacks = jest
    .mocked(AppState.addEventListener)
    .mock.calls.filter(([event]) => event === "change")
    .map(([, callback]) => callback);
  act(() => callbacks.forEach((callback) => callback("background")));
  await act(async () =>
    pending.resolve({
      ...snapshot,
      confidentialReadState: "locked",
      fundingAtoms: "1500000",
      totalAtoms: "4000000",
      accounts: [{ ...snapshot.accounts[0]!, balanceAtoms: "1500000" }, snapshot.accounts[1]!],
    }),
  );
  expect(screen.getByLabelText("3 USD")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Unlock private balance" })).toBeNull();
  read.mockResolvedValue({ ...snapshot, confidentialReadState: "ready" });
  await act(async () => callbacks.forEach((callback) => callback("active")));
  expect(screen.queryByRole("button", { name: "Unlock private balance" })).toBeNull();
});
