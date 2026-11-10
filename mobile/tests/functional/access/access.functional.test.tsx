import { tokenCatalogService } from "@/services/tokenCatalog";
import { nativeWalletAccess } from "@/services/wallet/access";
import { act, screen, userEvent } from "@testing-library/react-native";
import { AccessibilityInfo, AppState, Linking } from "react-native";
import { AccessRejectedError, type DemoSession } from "@/services/access";
import { deferred, renderApp } from "../../support/renderApp";

beforeEach(() => {
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest
    .spyOn(tokenCatalogService, "list")
    .mockResolvedValue({ list: [], page: 0, items: 20, total: 0 });
});
afterEach(() => jest.restoreAllMocks());
async function openAccess() {
  await screen.findByRole("button", { name: "Continue with passkey" });
}
async function signIn() {
  await openAccess();
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
}
test("welcome, access, all tabs and disconnect form a complete demo journey", async () => {
  renderApp();
  await signIn();
  for (const name of ["Vaults", "Swap", "Settings"]) {
    await userEvent.press(screen.getByLabelText(`${name} tab`));
  }
  expect(screen.getByText("Access method: Passkey")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Open UI preview" })).toBeNull();
  await userEvent.press(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(screen.queryByLabelText("Settings tab")).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
});
test("access offers only passkeys and requests the passkey method", async () => {
  const request = jest.fn().mockResolvedValue({ kind: "demo", method: "Demo passkey" });
  renderApp({ request });
  await openAccess();
  expect(screen.queryByRole("button", { name: "Choose wallet" })).toBeNull();
  expect(screen.getByRole("header", { name: "DeFi in Stealth Mode" })).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("Demo passkey");
});
test.each([new Error("offline"), new AccessRejectedError("rejected")])(
  "recovers from access failure %s",
  async (cause) => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue({ kind: "demo", method: "Demo passkey" });
    renderApp({ request });
    await openAccess();
    await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      cause instanceof AccessRejectedError
        ? "Access was rejected. You can try again."
        : "Access failed. Please try again.",
    );
    await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
    expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
  },
);
test("prevents duplicate requests and ignores a late success after cancellation", async () => {
  const pending = deferred<DemoSession>();
  const request = jest.fn().mockReturnValue(pending.promise);
  renderApp({ request });
  await openAccess();
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  const loading = screen.getByRole("button", { name: "Opening access" });
  expect(loading).toBeDisabled();
  expect(screen.getByText("Waiting for passkey")).toBeVisible();
  await userEvent.press(loading);
  expect(request).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Cancel access" }));
  expect(screen.queryByText("Waiting for passkey")).toBeNull();
  await act(async () => pending.resolve({ kind: "demo", method: "Demo passkey" }));
  expect(screen.getByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
});
test.each([
  "home",
  "vaults",
  "exchange",
  "settings",
  "wallet-picker",
  "notifications",
  "garbage?token=ignored",
])("signed-out deep link %s never exposes tabs", async (path) => {
  jest.mocked(Linking.getInitialURL).mockResolvedValue(`gizu-dev://${path}`);
  renderApp();
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  expect(screen.queryByLabelText("Settings tab")).toBeNull();
});

test("an old access deep link opens welcome directly", async () => {
  jest.mocked(Linking.getInitialURL).mockResolvedValue("gizu-dev://access");
  renderApp();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
});

test("cancelling access ignores a later service rejection", async () => {
  const pending = deferred<DemoSession>();
  renderApp({ request: () => pending.promise });
  await openAccess();
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await userEvent.press(screen.getByRole("button", { name: "Cancel access" }));
  await act(async () => pending.reject(new Error("late failure")));
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("runtime links are gated before access and work only inside a demo session", async () => {
  const subscribe = jest.spyOn(Linking, "addEventListener");
  renderApp();
  await screen.findByRole("button", { name: "Continue with passkey" });
  async function send(url: string) {
    const listener = subscribe.mock.calls.filter(([type]) => type === "url").at(-1)?.[1];
    if (!listener) throw new Error("URL subscription missing");
    await act(async () => listener({ url }));
  }
  await send("gizu-dev://settings");
  expect(screen.queryByLabelText("Settings tab")).toBeNull();
  await signIn();
  await send("gizu-dev://settings");
  expect(await screen.findByRole("header", { name: "Account" })).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Continue with passkey" });
  await send("gizu-dev://exchange");
  expect(screen.queryByLabelText("Swap tab")).toBeNull();
});

test("account actions open secondary pages and the selected capsule tab is accessible", async () => {
  renderApp();
  await signIn();
  expect(screen.getByRole("button", { name: "Home tab", selected: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Receive" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /Notifications, \d+ unread/ })).toBeEnabled();
  expect(screen.queryByText(/Demo mode|No real funds/)).toBeNull();
  await userEvent.press(screen.getByLabelText("Settings tab"));
  expect(screen.getByRole("button", { name: "Settings tab", selected: true })).toBeVisible();
  for (const name of [
    "Passkey wallet",
    "Transaction signing",
    "Push alerts",
    "Contact desk",
    "Terms and disclosures",
  ]) {
    const row = screen.getByRole("button", { name });
    expect(row).toBeEnabled();
    await userEvent.press(row);
    expect(await screen.findByRole("header", { name })).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("header", { name: "Account" })).toBeVisible();
  }
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
});

test("updated branding, confidential vaults and Swap availability retain navigation", async () => {
  renderApp();
  expect(await screen.findByRole("header", { name: /DeFi.*Stealth.*Mode/s })).toBeVisible();
  await signIn();
  expect(screen.queryByRole("header", { name: "Confidential vaults" })).toBeNull();
  await userEvent.press(screen.getByLabelText("Swap tab"));
  expect(await screen.findByRole("header", { name: "Swap" })).toBeVisible();
  expect(screen.queryByText("Buy tokens with USDC.")).toBeNull();
  expect(screen.getByRole("button", { name: "Swap" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Buy vault units" })).toBeNull();
  await userEvent.press(screen.getByLabelText("Vaults tab"));
  expect(await screen.findByRole("header", { name: "Confidential vaults" })).toBeVisible();
});

test.each([true, false])(
  "welcome stays readable and actionable with reduced motion %s",
  async (reduced) => {
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      listener("active");
      return { remove: jest.fn() };
    });
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduced);
    renderApp();
    expect(await screen.findByRole("header", { name: "DeFi in Stealth Mode" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with passkey" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request access" })).toBeEnabled();
    await openAccess();
    expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
    expect(await screen.findByRole("header", { name: "DeFi in Stealth Mode" })).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Request access" }));
    expect(await screen.findByLabelText("Email address")).toBeVisible();
  },
);

test("disconnected native access stays on access screen without creating a demo session", async () => {
  renderApp(nativeWalletAccess);
  await openAccess();
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  expect(
    await screen.findByText(/Wallet access (is temporarily unavailable|requires Android)/),
  ).toBeVisible();
  expect(screen.queryByRole("header", { name: "Your portfolio" })).toBeNull();
  expect(screen.queryByLabelText("Settings tab")).toBeNull();
});
