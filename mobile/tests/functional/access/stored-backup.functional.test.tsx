import * as nativeBridge from "@/services/wallet/nativeBridge";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createStoredWalletAccess, type StoredWalletBridge } from "@/services/wallet/storedAccess";
import type { StoredWalletState } from "@/domain/wallet/storedSigner";
import { deferred } from "../../support/renderApp";

const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const required: StoredWalletState = { status: "backupRequired", walletId };
const ready: StoredWalletState = {
  status: "ready",
  walletId,
  accounts: [{ accountIndex: 0, address: "0x" + "1".repeat(40), chainId: 10143 }],
};
function setup() {
  const native = {
    getWalletState: jest
      .fn<Promise<StoredWalletState>, []>()
      .mockResolvedValue({ status: "absent" }),
    createWallet: jest.fn().mockImplementation(async () => {
      native.getWalletState.mockResolvedValue(required);
      return required;
    }),
    backupWallet: jest.fn().mockResolvedValue(ready),
    openWallet: jest.fn().mockResolvedValue(ready),
    restoreWallet: jest.fn().mockResolvedValue(ready),
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: "0x" + "1".repeat(40) }),
    lock: jest.fn(),
  } satisfies StoredWalletBridge;
  const view = render(
    <AppRoot
      accessService={createStoredWalletAccess(() => native)}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("0") }}
    />,
  );
  return { ...native, unmount: view.unmount };
}
beforeEach(() => jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null));
afterEach(() => jest.restoreAllMocks());
// The passkey action reads "Unlock wallet" once a local wallet exists.
const passkeyAction = { name: /^(Continue with passkey|Unlock wallet)$/ };
async function access() {
  await screen.findByRole("button", passkeyAction);
}
async function proceed() {
  await userEvent.press(await screen.findByRole("button", passkeyAction));
}

test("onboarding waits for verified backup then opens existing Home", async () => {
  const native = setup();
  const backup = deferred<StoredWalletState>();
  native.backupWallet.mockReturnValue(backup.promise);
  await access();
  await proceed();
  expect(await screen.findByRole("button", { name: "Cancel access" })).toBeVisible();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  await act(async () => backup.resolve(ready));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  expect(await screen.findByRole("header", { name: "Wallet backup" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Wallet backup" })).toBeNull();
  expect(
    screen.getByText("Recovery needs both the encrypted file and your original passkey."),
  ).toBeVisible();
  expect(
    await screen.findByRole("button", { name: "Save and verify wallet backup" }),
  ).toBeVisible();
});

test("failed backup retries the same wallet without creating new entropy", async () => {
  const native = setup();
  native.backupWallet.mockRejectedValueOnce(new Error("cancelled"));
  await access();
  await proceed();
  expect(await screen.findByRole("alert")).toHaveTextContent(/backup was not completed/);
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  await proceed();
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.createWallet).toHaveBeenCalledTimes(1);
  expect(native.backupWallet).toHaveBeenCalledTimes(2);
});

test("restore uses the native ceremony and never creates a replacement wallet", async () => {
  const native = setup();
  await access();
  await userEvent.press(await screen.findByRole("button", { name: "Restore wallet from backup" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.restoreWallet).toHaveBeenCalledTimes(1);
  expect(native.createWallet).not.toHaveBeenCalled();
});

test("an existing wallet is unlocked instead of offering restore", async () => {
  const native = setup();
  native.getWalletState.mockResolvedValue(ready);
  await userEvent.press(await screen.findByRole("button", { name: "Unlock wallet" }));
  expect(screen.queryByRole("button", { name: "Restore wallet from backup" })).toBeNull();
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.openWallet).toHaveBeenCalledTimes(1);
  expect(native.restoreWallet).not.toHaveBeenCalled();
});

test("an unreadable wallet offers only restore", async () => {
  const native = setup();
  native.getWalletState.mockResolvedValue({ status: "recoveryRequired" });
  const restore = await screen.findByRole("button", { name: "Restore wallet from backup" });
  expect(screen.getByText(/The wallet on this device can't be opened/)).toBeVisible();
  expect(screen.queryByRole("button", passkeyAction)).toBeNull();
  await userEvent.press(restore);
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.restoreWallet).toHaveBeenCalledTimes(1);
});

test("restore refused by an existing wallet guides the user to unlock it", async () => {
  const native = setup();
  native.restoreWallet.mockImplementationOnce(async () => {
    native.getWalletState.mockResolvedValue(ready);
    throw Object.assign(new Error("exists"), { code: "WALLET_EXISTS" });
  });
  await access();
  await userEvent.press(await screen.findByRole("button", { name: "Restore wallet from backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already has a wallet/);
  expect(await screen.findByRole("button", { name: "Unlock wallet" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Restore wallet from backup" })).toBeNull();
  expect(native.createWallet).not.toHaveBeenCalled();
});

test("cancel ignores a late backup result and keeps protected screens closed", async () => {
  const native = setup();
  const backup = deferred<StoredWalletState>();
  native.backupWallet.mockReturnValue(backup.promise);
  await access();
  await proceed();
  await userEvent.press(await screen.findByRole("button", { name: "Cancel access" }));
  await act(async () => backup.resolve(ready));
  expect(native.lock).toHaveBeenCalled();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Unlock wallet" })).toBeVisible();
});

test("Account can reverify backup and recover from cancellation without disconnecting", async () => {
  const native = setup();
  jest.spyOn(nativeBridge, "getStoredSigner").mockReturnValue(native);
  await access();
  await proceed();
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  expect(await screen.findByRole("header", { name: "Wallet backup" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Wallet backup" })).toBeNull();
  expect(
    screen.getByText("Recovery needs both the encrypted file and your original passkey."),
  ).toBeVisible();
  native.backupWallet.mockRejectedValueOnce(new Error("cancelled"));
  await userEvent.press(
    await screen.findByRole("button", { name: "Save and verify wallet backup" }),
  );
  expect(await screen.findByText(/Your existing wallet remains available/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Save and verify wallet backup" }));
  expect(await screen.findByText(/Backup saved and verified/)).toBeVisible();
  expect(native.createWallet).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save and verify wallet backup" })).toBeVisible();
});

test.each([
  ["WALLET_CANCELLED", "Wallet access was cancelled"],
  ["WALLET_TIMEOUT", "Wallet access timed out"],
  ["BUSY", "Another wallet operation"],
  ["PASSKEY_FAILED", "Apple could not complete the passkey request"],
  ["UNAVAILABLE", "Wallet access is unavailable right now"],
  ["UNKNOWN", "Wallet access or backup was not completed"],
])("%s shows safe guidance and retries the same wallet", async (code, message) => {
  const native = setup();
  native.backupWallet.mockRejectedValueOnce(
    Object.assign(new Error("sensitive native error payload"), { code }),
  );
  await access();
  await proceed();
  expect(await screen.findByRole("alert")).toHaveTextContent(new RegExp(message));
  expect(screen.queryByText(/sensitive native error payload/)).toBeNull();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  await proceed();
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.createWallet).toHaveBeenCalledTimes(1);
});

test("successful passkey login preserves native balance-read permission until disconnect", async () => {
  const native = setup();
  native.getWalletState.mockResolvedValue(ready);
  await access();
  await proceed();
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(native.openWallet).toHaveBeenCalledTimes(1);
  expect(native.lock).not.toHaveBeenCalled();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  await userEvent.press(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Unlock wallet" })).toBeVisible();
  expect(native.lock).toHaveBeenCalledTimes(1);
});
test("leaving an unfinished passkey login still cancels native access", async () => {
  const native = setup();
  native.getWalletState.mockResolvedValue(ready);
  const pending = deferred<StoredWalletState>();
  native.openWallet.mockReturnValue(pending.promise);
  await access();
  await proceed();
  native.unmount();
  expect(native.lock).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(ready));
  expect(native.getSwapDeposit).not.toHaveBeenCalled();
});
