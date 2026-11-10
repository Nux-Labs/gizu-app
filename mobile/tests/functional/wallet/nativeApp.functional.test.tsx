import { tokenCatalogService } from "@/services/tokenCatalog";
import type { WalletHistory } from "@/domain/wallet/types";
import { act, fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createNativeWalletAccess } from "@/development/legacySigner/access";
import { defaultPreferences } from "@/domain/preferences";
import { deferred } from "../../support/renderApp";

const address = "0x" + "1".repeat(40);
beforeEach(() => {
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest
    .spyOn(tokenCatalogService, "list")
    .mockResolvedValue({ list: [], page: 0, items: 20, total: 0 });
});
afterEach(() => jest.restoreAllMocks());
function setup() {
  const bridge = {
    openWallet: jest.fn().mockResolvedValue({ address, accountIndex: 0, chainId: 10143 }),
    lock: jest.fn(),
  };
  const balance = { getBalance: jest.fn().mockResolvedValue("19990574000000000000") };
  const transfers = {
    history: jest
      .fn<Promise<WalletHistory>, [string]>()
      .mockResolvedValue({ entries: [], blocked: false }),
    send: jest
      .fn<Promise<WalletHistory>, [string, string, string]>()
      .mockResolvedValue({ entries: [], blocked: false }),
    cancel: jest.fn(),
  };
  const clipboard = { copy: jest.fn().mockResolvedValue(undefined) };
  const store = {
    load: jest.fn().mockResolvedValue(defaultPreferences),
    save: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  render(
    <AppRoot
      accessService={createNativeWalletAccess(() => bridge)}
      opportunityService={{
        list: jest.fn().mockResolvedValue({ list: [], page: 0, items: 8, total: 0 }),
        detail: jest.fn().mockRejectedValue(new Error("not used")),
        tvlRecords: jest.fn().mockResolvedValue([]),
      }}
      walletBalanceService={balance}
      walletTransferService={transfers}
      accountDependencies={{ clipboard, store }}
    />,
  );
  return { bridge, balance, clipboard, store, transfers };
}
async function open() {
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
}

test("native access opens existing Home and Account with live units and no fixture journeys", async () => {
  const { bridge, clipboard, store } = setup();
  await open();
  expect(await screen.findByLabelText("19.990574 MON")).toBeVisible();
  expect(screen.getByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(screen.queryByRole("header", { name: "Your wallet" })).toBeNull();
  expect(screen.queryByText(/Available USDC/)).toBeNull();
  expect(screen.getByRole("button", { name: "Receive" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
  await userEvent.press(screen.getByLabelText("Earn tab"));
  expect(await screen.findByLabelText("Search opportunities")).toBeVisible();
  expect(screen.queryByRole("button", { name: "View Helix Alpha" })).toBeNull();
  await userEvent.press(screen.getByLabelText("Swap tab"));
  expect(await screen.findByRole("header", { name: "Swap" })).toBeVisible();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  expect(await screen.findByLabelText("Account address: " + address)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  expect(clipboard.copy).toHaveBeenCalledWith(address);
  await userEvent.press(screen.getByRole("button", { name: "Passkey wallet" }));
  expect(await screen.findByText(/Your passkey opens Account 0/)).toBeVisible();
  expect(screen.queryByText(/registration is not connected/)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Transaction signing" }));
  expect(await screen.findByText(/Signing requires a separate passkey unlock/)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Push alerts" }));
  fireEvent(
    await screen.findByRole("switch", { name: "Receive push alerts" }),
    "valueChange",
    true,
  );
  expect(store.save).toHaveBeenCalledWith(address, { ...defaultPreferences, alerts: true });
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(screen.queryByLabelText("Home tab")).toBeNull();
  expect(bridge.lock).toHaveBeenCalled();
  expect(store.clear).toHaveBeenCalledWith(address);
});

test("balance failure is unavailable rather than zero and retry can return a real zero", async () => {
  const { balance } = setup();
  balance.getBalance.mockRejectedValueOnce(new Error("offline"));
  await open();
  expect(
    await screen.findByRole("alert", { name: "Balance unavailable. Please retry." }),
  ).toHaveTextContent("Balance unavailable. Please retry.");
  expect(screen.queryByLabelText("0 MON")).toBeNull();
  balance.getBalance.mockResolvedValueOnce("0");
  await userEvent.press(screen.getByRole("button", { name: "Retry balance" }));
  expect(await screen.findByLabelText("0 MON")).toBeVisible();
});

test("disconnect aborts a balance request and late results cannot leak into the next account", async () => {
  const { balance, bridge } = setup();
  const pending = deferred<string>();
  balance.getBalance.mockReturnValueOnce(pending.promise);
  await open();
  expect(await screen.findByText("Loading balance…")).toBeVisible();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  await userEvent.press(await screen.findByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Continue with passkey" });
  expect(balance.getBalance.mock.calls[0][1].aborted).toBe(true);
  bridge.openWallet.mockResolvedValueOnce({
    address: "0x" + "2".repeat(40),
    accountIndex: 0,
    chainId: 10143,
  });
  balance.getBalance.mockResolvedValueOnce("0");
  await open();
  expect(await screen.findByLabelText("0 MON")).toBeVisible();
  await act(async () => pending.resolve("1000000000000000000"));
  expect(screen.queryByLabelText("1 MON")).toBeNull();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  expect(await screen.findByLabelText("Account address: 0x" + "2".repeat(40))).toBeVisible();
});

test.each(["vault/helix"])("native deep link %s cannot reach a mock service", async (path) => {
  const subscribe = jest.spyOn(Linking, "addEventListener");
  setup();
  await open();
  await screen.findByLabelText("19.990574 MON");
  const listener = subscribe.mock.calls.filter(([type]) => type === "url").at(-1)?.[1];
  if (!listener) throw new Error("Missing listener");
  await act(async () => listener({ url: "gizu-dev://" + path }));
  expect(
    await screen.findByText("This service is not connected to your wallet yet."),
  ).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
});

const recipient = "0x" + "3".repeat(40);
const hash = "0x" + "a".repeat(64);
const record = {
  transactionHash: hash,
  nonce: "0",
  status: "pending",
  to: recipient,
  valueWei: "1000000000000000",
};
test("deposit copies the real address without signing and withdrawal validates before native approval", async () => {
  const { transfers, clipboard, bridge } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Receive" }));
  expect(await screen.findByRole("header", { name: "Receive" })).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  expect(clipboard.copy).toHaveBeenCalledWith(address);
  expect(transfers.send).not.toHaveBeenCalled();
  expect(bridge.openWallet).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Send" }));
  await userEvent.press(await screen.findByRole("button", { name: "Review send" }));
  expect(
    await screen.findByText("Enter a full recipient address and an amount above 0 up to 0.1 MON."),
  ).toBeVisible();
  expect(transfers.send).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText("Recipient address"), recipient);
  fireEvent.changeText(screen.getByLabelText("Amount in MON"), "0.001");
  const pending = deferred<WalletHistory>();
  transfers.send.mockReturnValueOnce(pending.promise);
  await userEvent.press(screen.getByRole("button", { name: "Review send" }));
  expect(screen.getByRole("button", { name: "Review send" })).toBeDisabled();
  expect(screen.getByText("Waiting for passkey")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Review send" }));
  expect(transfers.send).toHaveBeenCalledTimes(1);
  expect(transfers.send).toHaveBeenCalledWith(address, recipient, "0.001");
  await act(async () => pending.resolve({ entries: [record], blocked: true }));
  expect(await screen.findByText("Pending")).toBeVisible();
  expect(screen.queryByText("Waiting for passkey")).toBeNull();
  expect(screen.getByRole("button", { name: "Review send" })).toBeDisabled();
  transfers.history.mockResolvedValue({
    entries: [{ ...record, status: "finalized" }],
    blocked: false,
  });
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByText("Finalized")).toBeVisible();
  expect(transfers.send).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "View activity" }));
  expect(await screen.findByLabelText("Transaction hash: " + hash)).toBeVisible();
  expect(screen.getByText("0.001 MON")).toBeVisible();
});

test("cancelled or uncertain native requests require reconciliation before retry", async () => {
  const { transfers } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Send" }));
  fireEvent.changeText(await screen.findByLabelText("Recipient address"), recipient);
  transfers.send.mockRejectedValueOnce(new Error("cancelled"));
  await userEvent.press(screen.getByRole("button", { name: "Review send" }));
  expect(await screen.findByText(/Transfer stopped or cancelled/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Review send" })).toBeDisabled();
  transfers.history.mockResolvedValueOnce({
    entries: [{ ...record, status: "unknown" }],
    blocked: true,
  });
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByText("Unknown — refresh status")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review send" })).toBeDisabled();
  transfers.history.mockResolvedValueOnce({
    entries: [{ ...record, status: "reverted" }],
    blocked: false,
  });
  await userEvent.press(screen.getByRole("button", { name: "Check status" }));
  expect(await screen.findByText("Failed on-chain")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review send" })).toBeEnabled();
  expect(transfers.send).toHaveBeenCalledTimes(1);
});

test("activity loads older journal records on entry without inventing missing details", async () => {
  const { transfers, bridge } = setup();
  transfers.history.mockResolvedValue({
    entries: [{ transactionHash: hash, nonce: "1", status: "finalized" }],
    blocked: false,
  });
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "View activity" }));
  expect(
    await screen.findByText("Earlier transfer — amount and recipient details were not saved."),
  ).toBeVisible();
  expect(transfers.history).toHaveBeenCalledWith(address);
  expect(bridge.openWallet).toHaveBeenCalledTimes(1);
  transfers.history.mockRejectedValueOnce(new Error("offline"));
  await userEvent.press(screen.getByRole("button", { name: "Refresh activity" }));
  expect(await screen.findByText(/Could not refresh history/)).toBeVisible();
  expect(screen.getByLabelText("Transaction hash: " + hash)).toBeVisible();
});

test("closing withdrawal preserves the operation and Activity observes its result", async () => {
  const { transfers } = setup();
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "Send" }));
  fireEvent.changeText(await screen.findByLabelText("Recipient address"), recipient);
  const pending = deferred<WalletHistory>();
  transfers.send.mockReturnValueOnce(pending.promise);
  await userEvent.press(screen.getByRole("button", { name: "Review send" }));
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "View activity" }));
  await act(async () => pending.resolve({ entries: [record], blocked: true }));
  expect(await screen.findByText("Pending")).toBeVisible();
  expect(transfers.send).toHaveBeenCalledTimes(1);
  expect(transfers.cancel).not.toHaveBeenCalled();
});

test("native notifications open an empty inbox instead of mock alerts", async () => {
  setup();
  await open();
  await screen.findByLabelText("19.990574 MON");
  await userEvent.press(screen.getByRole("button", { name: "Notifications, 0 unread" }));
  expect(await screen.findByText("No notifications yet.")).toBeVisible();
});
