import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppRoot } from "@/application/AppRoot";
import * as nativeBridge from "@/services/wallet/nativeBridge";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { validateMainnetPortfolio } from "@/features/wallet/MainnetWalletProvider";
import portfolioFixtures from "../../../modules/gizu-stored-signer/ios/Tests/Fixtures/public-portfolio.json";
import { deferred } from "../../support/renderApp";

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
  await screen.findByText("3 USDC");
  return { read, transfers };
}
afterEach(() => jest.restoreAllMocks());

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
  expect(screen.getByText("Previously checked: 2 USDC (private)")).toBeVisible();
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
  expect(await screen.findByText("2.5 USDC (private)")).toBeVisible();
  expect(screen.getByLabelText("5.5 USDC")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Unlock private balance" })).toBeNull();
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(transfers).not.toHaveBeenCalled();
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
  expect(screen.getByLabelText("3 USDC")).toBeVisible();
});

test("a declined private balance unlock preserves cached amounts and allows a retry", async () => {
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue({
    openWallet: jest.fn().mockRejectedValue(new Error("Wallet unlock cancelled.")),
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSigner>>);
  await open({ ...snapshot, confidentialReadState: "locked", ownedAssets: [] });
  fireEvent.press(screen.getByRole("button", { name: "Unlock private balance" }));
  expect(await screen.findByText("Wallet unlock cancelled.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Unlock private balance" })).toBeEnabled();
  expect(screen.getByLabelText("3 USDC")).toBeVisible();
});

test("shared Rust, Swift and Kotlin fixtures satisfy the Home contract", () => {
  for (const fixture of portfolioFixtures.cases) {
    const value = { ...fixture.expected, history: [] } as MainnetPortfolioSnapshot;
    expect(validateMainnetPortfolio(value, "portfolio-fixture")).toBe(value);
  }
});

test("mainnet Home includes receiving USDC, Deposit uses funding address, Withdraw never signs", async () => {
  const { transfers } = await open();
  expect(screen.getByLabelText("3 USDC")).toBeVisible();
  expect(screen.queryByText("Swap funding: 0.5 USDC")).toBeNull();
  expect(screen.queryByText("USDC accounts")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: false }));
  expect(screen.getByText("Swap funding: 0.5 USDC")).toBeVisible();
  expect(screen.getByText("Receiving wallets: 2.5 USDC")).toBeVisible();
  expect(screen.queryByText("USDC accounts")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: true }));
  expect(screen.queryByText("Swap funding: 0.5 USDC")).toBeNull();
  expect(screen.getByLabelText("3 USDC")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Wallet details" })).toBeNull();
  expect(screen.queryByText(/testnet MON/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Receive" }));
  expect(
    await screen.findByText("Swap funding address · Receive USDC on Monad mainnet only."),
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
  expect(await screen.findByText("Sell GOOGL")).toBeVisible();
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
  await screen.findByLabelText("3 USDC");
  fireEvent.press(screen.getByLabelText("Swap tab"));
  expect(await screen.findByText("Available: 3 USDC")).toBeVisible();
  expect(screen.getByLabelText("Amount in USDC")).toBeVisible();
  expect(screen.queryByText(/maximum 10 USDC/)).toBeNull();
});

test("Home balance shows observed performance and expands to a period chart", async () => {
  const day = 24 * 3_600_000;
  await AsyncStorage.setItem(
    `gizu:balance-history:v1:${encodeURIComponent(`${walletId}:portfolio-value-v1`)}`,
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

test("Home does not compare portfolio value against older liquid-only history", async () => {
  await AsyncStorage.setItem(
    `gizu:balance-history:v1:${walletId}`,
    JSON.stringify([{ at: snapshot.checkedAt - 20 * 24 * 3_600_000, atoms: "2000000" }]),
  );
  await open();
  expect(screen.queryByText("+$1.00 (+50%) · past month")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Balance details", expanded: false }));
  expect(screen.getByLabelText("Balance history is not available yet")).toBeVisible();
});
