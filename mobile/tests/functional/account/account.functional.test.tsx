import { act, fireEvent, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { Linking } from "react-native";
import { profileFixture } from "@/services/fixtures/profile";
import { defaultPreferences } from "@/domain/preferences";
import { deferred, renderApp } from "../../support/renderApp";
import { memoryPreferences, openSettings, signInToAccount } from "../../support/account";
beforeEach(() => jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null));
afterEach(() => jest.restoreAllMocks());
async function open(name: string) {
  await userEvent.press(screen.getByRole("button", { name }));
  await screen.findByRole("header", { name });
}
test("copies the complete address with feedback and retries clipboard failure", async () => {
  jest
    .mocked(Clipboard.setStringAsync)
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(true);
  renderApp();
  await signInToAccount();
  await openSettings();
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy address. Try again.");
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  // Native-driven toast animation is verified separately on device.
  expect(await screen.findByText("Address copied.")).toBeOnTheScreen();
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(profileFixture.address);
  expect(profileFixture.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});
test("clipboard false result fails and a pending copy cannot duplicate or update a dismissed page", async () => {
  jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
  const pending = deferred<void>();
  const copy = jest.fn().mockReturnValue(pending.promise);
  const app = renderApp();
  await signInToAccount();
  await openSettings();
  await userEvent.press(screen.getByRole("button", { name: "Copy account address" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  app.unmount();
  renderApp(undefined, undefined, undefined, undefined, { dependencies: { clipboard: { copy } } });
  await signInToAccount();
  await openSettings();
  const button = screen.getByRole("button", { name: "Copy account address" });
  act(() => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(copy).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Continue with passkey" });
  await act(async () => pending.resolve());
  expect(screen.queryByText("Address copied.")).toBeNull();
});
test("alerts persist across app remount and clear on disconnect", async () => {
  const { store, storage } = memoryPreferences();
  const dependencies = { store };
  const app = renderApp(undefined, undefined, undefined, undefined, { dependencies });
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  expect(screen.getByRole("switch", { name: "Receive push alerts" })).not.toBeChecked();
  fireEvent(screen.getByRole("switch"), "valueChange", true);
  await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
  expect(screen.getByText(/Push delivery is not available yet/)).toBeVisible();
  app.unmount();
  renderApp(undefined, undefined, undefined, undefined, { dependencies });
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  expect(screen.getByRole("switch")).toBeChecked();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
  expect(storage.removeItem).toHaveBeenCalledWith(`gizu:preferences:v1:${profileFixture.id}`);
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  expect(screen.getByRole("switch")).not.toBeChecked();
});
test("failed preference hydration blocks edits until retry; failed save preserves the last committed value", async () => {
  const { store, storage } = memoryPreferences();
  storage.getItem.mockRejectedValueOnce(new Error("read failed"));
  renderApp(undefined, undefined, undefined, undefined, { dependencies: { store } });
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  expect(screen.getByRole("switch")).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Retry preferences" }));
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  storage.setItem.mockRejectedValueOnce(new Error("disk full"));
  fireEvent(screen.getByRole("switch"), "valueChange", true);
  expect(await screen.findByRole("alert")).toHaveTextContent(/Preference was not saved/);
  expect(screen.getByRole("switch")).not.toBeChecked();
  fireEvent(screen.getByRole("switch"), "valueChange", true);
  await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
});
test("pending writes disable changes and disconnect until persistence completes", async () => {
  const { store, storage } = memoryPreferences();
  const pending = deferred<void>();
  storage.setItem.mockReturnValueOnce(pending.promise);
  renderApp(undefined, undefined, undefined, undefined, { dependencies: { store } });
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  const alerts = screen.getByRole("switch");
  act(() => {
    fireEvent(alerts, "valueChange", true);
    fireEvent(alerts, "valueChange", true);
  });
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("switch")).toBeDisabled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  await act(async () => pending.resolve());
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
});
test("logout cleanup failure stays signed in with retry and duplicate cleanup is blocked", async () => {
  const { store, storage } = memoryPreferences();
  const pending = deferred<void>();
  storage.removeItem
    .mockRejectedValueOnce(new Error("failed"))
    .mockReturnValueOnce(pending.promise);
  renderApp(undefined, undefined, undefined, undefined, { dependencies: { store } });
  await signInToAccount();
  await openSettings();
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/You are still signed in/);
  const button = screen.getByRole("button", { name: "Disconnect" });
  act(() => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(storage.removeItem).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve());
  expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
});
test("disconnect during hydration discards its late result for the next session", async () => {
  const { store } = memoryPreferences();
  const pending = deferred<typeof defaultPreferences>();
  jest.spyOn(store, "load").mockReturnValueOnce(pending.promise);
  renderApp(undefined, undefined, undefined, undefined, { dependencies: { store } });
  await signInToAccount();
  await openSettings();
  expect(screen.getByText("Loading preferences…")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Continue with passkey" });
  await signInToAccount();
  await openSettings();
  await open("Push alerts");
  await act(async () => pending.resolve({ ...defaultPreferences, alerts: true }));
  expect(screen.getByRole("switch")).not.toBeChecked();
});
test("security, support and disclosure actions have explicit availability", async () => {
  renderApp();
  await signInToAccount();
  await openSettings();
  expect(screen.queryByText("Preferences")).toBeNull();
  expect(screen.queryByRole("button", { name: "Currency" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Statements" })).toBeNull();
  for (const [title, actions] of [
    ["Passkey wallet", ["Add backup passkey"]],
    ["Transaction signing", ["Change signing policy"]],
    ["Contact desk", ["Start secure message", "Book callback"]],
    [
      "Terms and disclosures",
      ["Member agreement", "Risk disclosure", "Privacy policy", "Fee schedule"],
    ],
  ] as const) {
    await open(title);
    if (title === "Transaction signing") {
      expect(screen.getByText("Preview only")).toBeVisible();
      expect(screen.queryByText(/No biometric policy or spending cap is enforced/)).toBeNull();
      await userEvent.press(screen.getByRole("button", { name: "Signing approval details" }));
      expect(screen.getByText(/No biometric policy or spending cap is enforced/)).toBeVisible();
    }
    for (const name of actions) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      await userEvent.press(screen.getByRole("button", { name }));
      expect(screen.getByRole("header", { name: title })).toBeVisible();
    }
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
  }
});
