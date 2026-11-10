import { act, screen, userEvent } from "@testing-library/react-native";
import { Dimensions, Linking, Share } from "react-native";
import { renderApp, deferred } from "../../support/renderApp";
import { investmentFixture } from "@/services/fixtures/investments";
import { OfflineError, type InvestmentService } from "@/services/investments";
import type { InvestmentSnapshot } from "@/domain/investments";

beforeEach(() => jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null));
afterEach(() => jest.restoreAllMocks());
async function enter(service?: InvestmentService) {
  renderApp(undefined, service);
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await screen.findByRole("header", { name: "Your portfolio" });
}
async function openVault() {
  await userEvent.press(await screen.findByRole("button", { name: "Open HLX holding" }));
  await screen.findByRole("header", { name: "Helix Alpha" });
}
test("browses portfolio, periods, holdings, filtered vault details and activity", async () => {
  await enter();
  expect(await screen.findByText("$810,838.24")).toBeVisible();
  expect(screen.queryByRole("header", { name: "Earn" })).toBeNull();
  expect(screen.queryByRole("button", { name: "See all vaults" })).toBeNull();
  await userEvent.press(screen.getByRole("radio", { name: "1D" }));
  expect(screen.getByLabelText(/1D index:.*8 samples/)).toBeVisible();
  await openVault();
  expect(screen.getByText("$1.8342")).toBeVisible();
  expect(screen.getByText("46%")).toBeVisible();
  expect(screen.getByText("$25,000")).toBeVisible();
  await userEvent.press(screen.getByRole("radio", { name: "1Y" }));
  expect(screen.getByLabelText(/1Y index:.*48 samples/)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(screen.getByLabelText("Earn tab"));
  const search = screen.getByLabelText("Search name, ticker, strategy or manager");
  await userEvent.type(search, "OBSIDIAN PARTNERS");
  await userEvent.press(screen.getByRole("radio", { name: "Low risk" }));
  expect(screen.getByText("1 vault found")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "View Obsidian Credit" }));
  expect(await screen.findByText("$12.0940")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByLabelText("Search name, ticker, strategy or manager"),
  ).toHaveDisplayValue("OBSIDIAN PARTNERS");
  await userEvent.press(screen.getByRole("radio", { name: "High risk" }));
  expect(screen.getByText("No vaults match your filters.")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("4 vaults found")).toBeVisible();
  await userEvent.press(screen.getByLabelText("Home tab"));
  await userEvent.press(screen.getByRole("button", { name: "View activity" }));
  expect(await screen.findByText("September · Bought HLX")).toBeVisible();
  expect(screen.getByText("$120,000.00")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
});
test("shows initial loading and recovers from an adapter failure without duplicate refreshes", async () => {
  const pending = deferred<InvestmentSnapshot>();
  const load = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(investmentFixture);
  await enter({ load });
  const loading = screen.getByRole("button", { name: "Loading data" });
  expect(loading).toBeDisabled();
  await userEvent.press(loading);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error("fixture unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to refresh data. Please retry.",
  );
  await userEvent.press(screen.getByRole("button", { name: "Retry data" }));
  expect(await screen.findByText("$810,838.24")).toBeVisible();
});
test.each(["stale", "offline"] as const)("labels a %s snapshot", async (freshness) => {
  await enter({ load: async () => ({ ...investmentFixture, freshness }) });
  expect(
    await screen.findByText(
      freshness === "offline"
        ? "Offline snapshot — values may be outdated."
        : "Stale snapshot — values may be outdated.",
    ),
  ).toBeVisible();
});
test.each([new OfflineError("offline"), new Error("server")])(
  "keeps cached values on refresh failure and recovers",
  async (failure) => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(investmentFixture)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(investmentFixture);
    await enter({ load });
    await userEvent.press(await screen.findByRole("button", { name: "Refresh data" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByText("$810,838.24")).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Retry data" }));
    await screen.findByRole("button", { name: "Refresh data" });
    expect(screen.queryByRole("alert")).toBeNull();
  },
);
test("empty portfolio, charts, discovery and activity remain navigable", async () => {
  await enter({
    load: async () => ({
      ...investmentFixture,
      vaults: [],
      holdings: [],
      activity: [],
      portfolioSeries: [],
    }),
  });
  expect(await screen.findByText("$0.00")).toBeVisible();
  expect(screen.getByText("No holdings yet.")).toBeVisible();
  expect(screen.getByLabelText("1M index: no history")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "View activity" }));
  expect(await screen.findByText("No activity yet.")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  await userEvent.press(await screen.findByRole("button", { name: "See all vaults" }));
  expect(screen.getByText("No vaults available.")).toBeVisible();
});
test("users without holdings see vault summaries instead of an empty holdings list", async () => {
  await enter({ load: async () => ({ ...investmentFixture, holdings: [] }) });
  expect(await screen.findByText("No holdings yet.")).toBeVisible();
  expect(screen.getByRole("header", { name: "Earn" })).toBeVisible();
  expect(screen.getByRole("button", { name: "View Helix Alpha" })).toBeVisible();
  expect(screen.getByRole("button", { name: "See all vaults" })).toBeVisible();
  expect(screen.queryByRole("header", { name: "Holdings" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open HLX holding" })).toBeNull();
});
test("missing vault has a recoverable empty state", async () => {
  await enter({ load: async () => ({ ...investmentFixture, vaults: [] }) });
  await userEvent.press(await screen.findByRole("button", { name: "Open HLX holding" }));
  expect(await screen.findByText("Vault not found in this snapshot.")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("header", { name: "Your portfolio" })).toBeVisible();
});
test("sharing sends only a labeled demo summary, handles dismissal and retries failure", async () => {
  const share = jest
    .spyOn(Share, "share")
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ action: Share.dismissedAction })
    .mockResolvedValue({ action: Share.sharedAction });
  await enter();
  await openVault();
  await userEvent.press(screen.getByRole("button", { name: "Share summary" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sharing failed. Please try again.");
  await userEvent.press(screen.getByRole("button", { name: "Share summary" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Share summary" }));
  expect(share).toHaveBeenLastCalledWith({
    message:
      "Gizu demo vault: Helix Alpha (HLX)\nHelix Capital\nMarket neutral basis trade\nMedium risk (fixture). Demo only; not an investment offer or live quote.",
  });
});
test("disconnect drops the snapshot and late responses cannot repopulate the next session", async () => {
  const pending = deferred<InvestmentSnapshot>();
  const load = jest
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ ...investmentFixture, holdings: [] });
  await enter({ load });
  await userEvent.press(screen.getByLabelText("Settings tab"));
  await userEvent.press(screen.getByRole("button", { name: "Disconnect" }));
  await act(async () => pending.resolve(investmentFixture));
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  expect(await screen.findByText("$0.00")).toBeVisible();
  expect(screen.queryByText("$810,838.24")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

test.each(["vault/helix", "activity"])(
  "protects cold %s links and provides a return destination after access",
  async (path) => {
    jest.mocked(Linking.getInitialURL).mockResolvedValue(`gizu-dev://${path}`);
    renderApp();
    expect(await screen.findByRole("button", { name: "Continue with passkey" })).toBeVisible();
    expect(screen.queryByText("$1.8342")).toBeNull();
    await screen.findByRole("button", { name: "Continue with passkey" });
    await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
    await userEvent.press(
      await screen.findByRole("button", {
        name: "Back",
      }),
    );
    expect(await screen.findByLabelText("Home tab")).toBeVisible();
  },
);

test("timestamp details are optional and clearing filters is contextual", async () => {
  await enter();
  await screen.findByText("$810,838.24");
  expect(screen.queryByText(`As of ${investmentFixture.asOf}`)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Show data timestamp" }));
  expect(screen.getByText(`As of ${investmentFixture.asOf}`)).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Hide data timestamp" }));
  expect(screen.queryByText(`As of ${investmentFixture.asOf}`)).toBeNull();
  await userEvent.press(screen.getByLabelText("Earn tab"));
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  await userEvent.press(screen.getByRole("radio", { name: "High risk" }));
  expect(screen.getByText("1 vault found")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

test("retains search, filters and chart selection across font size changes", async () => {
  const original = Dimensions.get("window");
  try {
    await enter();
    await userEvent.press(screen.getByRole("radio", { name: "1D" }));
    await userEvent.press(screen.getByLabelText("Earn tab"));
    await userEvent.type(
      screen.getByLabelText("Search name, ticker, strategy or manager"),
      "Vertex",
    );
    await userEvent.press(screen.getByRole("radio", { name: "High risk" }));
    act(() => Dimensions.set({ window: { ...original, width: 320, fontScale: 2 } }));
    expect(screen.getByLabelText("Search name, ticker, strategy or manager")).toHaveDisplayValue(
      "Vertex",
    );
    expect(screen.getByRole("radio", { name: "High risk" })).toBeChecked();
    expect(screen.getByText("1 vault found")).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "View Vertex Quant" }));
    expect(await screen.findByText("26.7%")).toBeVisible();
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
    await userEvent.press(screen.getByLabelText("Home tab"));
    expect(screen.getByRole("radio", { name: "1D" })).toBeChecked();
  } finally {
    act(() => Dimensions.set({ window: original }));
  }
});
