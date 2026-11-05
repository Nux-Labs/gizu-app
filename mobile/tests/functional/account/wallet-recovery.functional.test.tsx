import { act, fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { WalletRecoveryAction } from "@/features/account/WalletRecoveryAction";
import type { WalletRecoveryService, WalletRecoveryStatus } from "@/domain/wallet/recovery";
import { deferred } from "../../support/renderApp";

const initial: WalletRecoveryStatus = {
  version: 1,
  phase: "idle",
  revision: 0,
  synced: false,
  scannedThroughCycle: -1,
  scanTargetCycle: -1,
  discoveredWallets: 0,
  recoveryRequired: false,
};
function service() {
  return {
    available: jest.fn().mockResolvedValue({ recovery: true, discovery: true }),
    status: jest.fn().mockResolvedValue(initial),
    sync: jest.fn().mockResolvedValue({ ...initial, phase: "ready", revision: 3, synced: true }),
    restore: jest.fn().mockResolvedValue({
      ...initial,
      phase: "ready",
      revision: 5,
      synced: true,
      recoveryRequired: true,
    }),
    discover: jest
      .fn()
      .mockResolvedValue({ ...initial, phase: "discovering", scanTargetCycle: 256 }),
    cancel: jest.fn().mockResolvedValue({
      ...initial,
      phase: "paused",
      scannedThroughCycle: 10,
      scanTargetCycle: 256,
      discoveredWallets: 2,
    }),
  } satisfies WalletRecoveryService;
}
test("sync reports an encrypted recovery checkpoint without replacing the exported backup", async () => {
  const api = service();
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  await userEvent.press(await screen.findByRole("button", { name: "Sync encrypted recovery" }));
  expect(await screen.findByText("Recovery metadata synced · revision 3")).toBeVisible();
  expect(screen.getByText(/Keep your encrypted backup file and original passkey/)).toBeVisible();
  expect(api.sync).toHaveBeenCalledWith("wallet");
});
test("restoring a newer catalogue explains that uncertain transactions need reconciliation", async () => {
  const api = service();
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  await userEvent.press(
    await screen.findByRole("button", { name: "Restore saved wallet catalogue" }),
  );
  expect(await screen.findByText(/Saved activity requires verified reconciliation/)).toBeVisible();
  expect(api.restore).toHaveBeenCalledWith("wallet");
  expect(api.discover).not.toHaveBeenCalled();
});
test("scanning uses an explicit bound, displays progress and preserves a cancelled cursor", async () => {
  const api = service();
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  const scan = await screen.findByRole("button", { name: "Scan for wallets" });
  fireEvent.changeText(screen.getByLabelText("Last deposit cycle to scan"), "2.5");
  expect(scan).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText("Last deposit cycle to scan"), "256");
  await userEvent.press(scan);
  await userEvent.press(await screen.findByRole("button", { name: "Pause wallet discovery" }));
  expect(
    await screen.findByText("Scanned through cycle 10 of 256 · 2 wallets with activity"),
  ).toBeVisible();
  expect(screen.getByText(/Reaching this bound does not prove/)).toBeVisible();
  expect(api.discover).toHaveBeenCalledWith("wallet", 256);
  expect(api.cancel).toHaveBeenCalledWith("wallet");
});
test("pausing can interrupt a pending discovery and its late result cannot replace progress", async () => {
  const api = service(),
    pending = deferred<WalletRecoveryStatus>();
  api.discover.mockReturnValueOnce(pending.promise);
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  await userEvent.press(await screen.findByRole("button", { name: "Scan for wallets" }));
  await userEvent.press(await screen.findByRole("button", { name: "Pause wallet discovery" }));
  await screen.findByText("Scanned through cycle 10 of 256 · 2 wallets with activity");
  await act(async () =>
    pending.resolve({ ...initial, phase: "ready", scanTargetCycle: 256, scannedThroughCycle: 256 }),
  );
  expect(
    screen.getByText("Scanned through cycle 10 of 256 · 2 wallets with activity"),
  ).toBeVisible();
});
test("older native builds show explicit unavailability and never start recovery", async () => {
  const api = service();
  api.available.mockResolvedValue({ recovery: false, discovery: false });
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  expect(await screen.findByText(/Wallet recovery requires an updated native app/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Sync encrypted recovery" })).toBeDisabled();
  expect(api.status).not.toHaveBeenCalled();
});
test("failed actions disclose no provider payload and duplicate sync is prevented", async () => {
  const api = service(),
    pending = deferred<WalletRecoveryStatus>();
  api.sync.mockReturnValueOnce(pending.promise);
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  const button = await screen.findByRole("button", { name: "Sync encrypted recovery" });
  await waitFor(() => expect(button).toBeEnabled());
  act(() => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(api.sync).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error("Bearer sensitive-private-provider-payload")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Wallet recovery is unavailable. Check your connection and try again.",
  );
  expect(screen.queryByText(/sensitive-private-provider-payload/)).toBeNull();
});
test("changing the active wallet discards a pending prior-wallet result", async () => {
  const api = service(),
    pending = deferred<WalletRecoveryStatus>();
  api.sync.mockReturnValueOnce(pending.promise);
  const view = render(<WalletRecoveryAction walletId="first" service={api} />);
  await userEvent.press(await screen.findByRole("button", { name: "Sync encrypted recovery" }));
  view.rerender(<WalletRecoveryAction walletId="second" service={api} />);
  await waitFor(() => expect(api.status).toHaveBeenLastCalledWith("second"));
  await act(async () =>
    pending.resolve({ ...initial, phase: "ready", revision: 99, synced: true }),
  );
  expect(screen.queryByText(/revision 99/)).toBeNull();
});
test("bounded native batches continue to the chosen scan limit without repeated user presses", async () => {
  const api = service();
  for (const cycle of [0, 1, 2])
    api.discover.mockResolvedValueOnce({
      ...initial,
      phase: cycle === 2 ? "ready" : "paused",
      scanTargetCycle: 2,
      scannedThroughCycle: cycle,
      discoveredWallets: cycle + 1,
      messageCode: "scanIncomplete",
    });
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  await screen.findByRole("button", { name: "Scan for wallets" });
  fireEvent.changeText(screen.getByLabelText("Last deposit cycle to scan"), "2");
  await userEvent.press(screen.getByRole("button", { name: "Scan for wallets" }));
  expect(
    await screen.findByText("Scanned through cycle 2 of 2 · 3 wallets with activity"),
  ).toBeVisible();
  expect(api.discover).toHaveBeenCalledTimes(3);
  expect(api.discover.mock.calls.every((call) => call[0] === "wallet" && call[1] === 2)).toBe(true);
});
test("a stale recovery checkpoint directs the user to restore instead of blaming their connection", async () => {
  const api = service();
  api.status
    .mockResolvedValueOnce(initial)
    .mockResolvedValue({ ...initial, phase: "error", messageCode: "conflict" });
  api.sync.mockRejectedValue(new Error("RECOVERY_RESTORE_REQUIRED"));
  render(<WalletRecoveryAction walletId="wallet" service={api} />);
  await userEvent.press(await screen.findByRole("button", { name: "Sync encrypted recovery" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recovery metadata changed. Restore the saved wallet catalogue before syncing again.",
  );
  expect(screen.getByRole("button", { name: "Restore saved wallet catalogue" })).toBeEnabled();
});
