import * as nativeBridge from "@/services/wallet/nativeBridge";
import type { WalletHistory } from "@/domain/wallet/types";
import { render, screen, userEvent, within } from "@testing-library/react-native";
import { Linking } from "react-native";
import { AppRoot } from "@/application/AppRoot";
import { createNativeWalletAccess } from "@/development/legacySigner/access";
import { defaultPreferences } from "@/domain/preferences";
import {
  mainnetOpportunity as opportunity,
  mockOpportunityService,
  opportunityPage as page,
  type MockOpportunityService,
} from "../../support/opportunities";

beforeEach(() => {
  // Discovery replaces holdings only after a successful empty native balance read.
  jest.spyOn(nativeBridge, "getStoredSwapSigner").mockReturnValue({
    getSwapHoldings: jest.fn().mockResolvedValue({
      checkedAt: 1_790_000_000_000,
      block: "0x123",
      holdings: [],
    }),
  } as unknown as NonNullable<ReturnType<typeof nativeBridge.getStoredSwapSigner>>);
});

const address = "0x" + "1".repeat(40);

beforeEach(() => jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null));
afterEach(() => jest.restoreAllMocks());

function setup(service: MockOpportunityService) {
  const bridge = {
    openWallet: jest.fn().mockResolvedValue({ address, accountIndex: 0, chainId: 10143 }),
    lock: jest.fn(),
  };
  const transfers = {
    history: jest
      .fn<Promise<WalletHistory>, [string]>()
      .mockResolvedValue({ entries: [], blocked: false }),
    send: jest.fn(),
    cancel: jest.fn(),
  };
  render(
    <AppRoot
      accessService={createNativeWalletAccess(() => bridge)}
      opportunityService={service}
      walletBalanceService={{ getBalance: jest.fn().mockResolvedValue("1000000000000000000") }}
      walletTransferService={transfers}
      accountDependencies={{
        clipboard: { copy: jest.fn() },
        store: {
          load: jest.fn().mockResolvedValue(defaultPreferences),
          save: jest.fn().mockResolvedValue(undefined),
          clear: jest.fn().mockResolvedValue(undefined),
        },
      }}
    />,
  );
}
async function open() {
  await screen.findByRole("button", { name: "Continue with passkey" });
  await userEvent.press(screen.getByRole("button", { name: "Continue with passkey" }));
  await screen.findByLabelText("1 MON");
}

test("Home previews the first four real mainnet vaults without invented performance", async () => {
  const service = mockOpportunityService([1, 2, 3, 4, 5].map(opportunity));
  setup(service);
  await open();
  expect(screen.getByLabelText("Performance chart, no history yet")).toBeVisible();
  const first = await screen.findByRole("button", { name: "View Mainnet vault 1" });
  expect(screen.getByRole("button", { name: "View Mainnet vault 4" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "View Mainnet vault 5" })).toBeNull();
  expect(within(first).getByText("6.1%")).toBeVisible();
  expect(service.list).toHaveBeenCalledWith(
    { search: "", protocol: "all", page: 0 },
    expect.anything(),
  );
  expect(screen.getByRole("button", { name: "Refresh balance" })).toBeEnabled();
  await userEvent.press(screen.getByRole("button", { name: "See all vaults" }));
  expect(await screen.findByLabelText("Search opportunities")).toBeVisible();
});

test("Home and Vaults cards open the mainnet vault detail and back returns", async () => {
  const service = mockOpportunityService([opportunity(1), opportunity(2)]);
  setup(service);
  await open();
  await userEvent.press(await screen.findByRole("button", { name: "View Mainnet vault 2" }));
  expect(await screen.findByLabelText("Mainnet vault 2")).toBeVisible();
  expect(service.detail).toHaveBeenCalledWith("op-2", expect.anything());
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: "See all vaults" })).toBeVisible();

  await userEvent.press(screen.getByLabelText("Earn tab"));
  await screen.findByLabelText("Search opportunities");
  const cards = await screen.findAllByRole("button", { name: "View Mainnet vault 1" });
  await userEvent.press(cards.at(-1)!);
  expect(await screen.findByLabelText("Mainnet vault 1")).toBeVisible();
  expect(service.detail).toHaveBeenLastCalledWith("op-1", expect.anything());
  // History is cached per vault for the session: both cards and the detail share it.
  expect(service.tvlRecords.mock.calls.filter(([id]) => id === "op-1")).toHaveLength(1);
});

test("Home vault preview recovers from a catalog failure with retry", async () => {
  const service = mockOpportunityService();
  service.list
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(page([opportunity(1)]));
  setup(service);
  await open();
  expect(await screen.findByText("Vault catalog unavailable.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "View Mainnet vault 1" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Retry vaults" }));
  expect(await screen.findByRole("button", { name: "View Mainnet vault 1" })).toBeVisible();
  expect(screen.queryByText("Vault catalog unavailable.")).toBeNull();
  expect(service.list).toHaveBeenCalledTimes(2);
});

test("Home vault preview shows an empty catalog instead of fixture vaults", async () => {
  setup(mockOpportunityService([]));
  await open();
  expect(await screen.findByText("No vaults available right now.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /View Helix/ })).toBeNull();
});
