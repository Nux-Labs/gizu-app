import { MainnetVaults } from "@/features/opportunities/MainnetVaults";
import { act, render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Linking } from "react-native";
import type { OpportunityDetail } from "@/domain/opportunities";
import { OpportunityDetailScreen } from "@/features/opportunities/OpportunityDetailScreen";
import { OpportunityServiceContext } from "@/features/opportunities/useOpportunities";
import { EarnScreen } from "@/features/earn/EarnScreen";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import { Typography } from "@/components/atoms/Typography";
import { earnProfiles } from "@/domain/earn/types";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import type { RootStackParamList } from "@/navigation/types";
import { deferred } from "../../support/renderApp";
import {
  mockOpportunityService,
  opportunityDetail,
  type MockOpportunityService,
} from "../../support/opportunities";

const Stack = createNativeStackNavigator<RootStackParamList>();

afterEach(() => jest.restoreAllMocks());

function setup(service: MockOpportunityService = mockOpportunityService()) {
  render(
    <SafeAreaProvider>
      <OpportunityServiceContext.Provider value={service}>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen
              name="OpportunityDetail"
              component={OpportunityDetailScreen}
              initialParams={{ id: "op-1" }}
            />
            <Stack.Screen name="Earn" component={EarnScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </OpportunityServiceContext.Provider>
    </SafeAreaProvider>,
  );
  return service;
}

test("detail shows metrics and marks unsupported deposits before navigation", async () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const service = mockOpportunityService();
  const pending = deferred<OpportunityDetail>();
  service.detail.mockReturnValueOnce(pending.promise);
  setup(service);
  expect(screen.getByLabelText("Loading vault…")).toBeVisible();
  await act(async () => pending.resolve(opportunityDetail(1)));

  expect(screen.getByLabelText("Mainnet vault 1")).toBeVisible();
  expect(screen.getByText("Aave · Monad · LIVE")).toBeVisible();
  expect(screen.getByLabelText("Total APR 6.1%")).toBeVisible();
  expect(screen.getByLabelText("TVL $1M")).toBeVisible();
  expect(
    await screen.findByLabelText("TVL history: Start $900K · End $1M (3 samples)"),
  ).toBeVisible();
  expect(screen.getByLabelText("Daily rewards: $1.5K")).toBeVisible();
  for (const heading of ["About", "How to", "Tokens", "Details", "Campaigns"]) {
    expect(screen.queryByRole("header", { name: heading })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  expect(service.detail).toHaveBeenCalledWith("op-1", expect.anything());
  expect(service.tvlRecords).toHaveBeenCalledWith("op-1", expect.anything());

  expect(screen.queryByRole("link", { name: "Open deposit page" })).toBeNull();
  expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  expect(screen.getByText("In-app deposits are not supported for this vault.")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Deposit" }));
  expect(
    screen.queryByText(
      "Deposits to this vault are not available in Gizu yet. No funds have moved.",
    ),
  ).toBeNull();
  expect(openURL).not.toHaveBeenCalled();
});

test("earnings estimate projects the typed amount at the vault rate", async () => {
  setup();
  expect(await screen.findByLabelText("Mainnet vault 1")).toBeVisible();
  expect(screen.getByLabelText("After 1 year: about $1,061.00, earning $61.00")).toBeVisible();
  const amount = screen.getByLabelText("Deposit amount in USD");
  await userEvent.clear(amount);
  await userEvent.type(amount, "2000");
  await userEvent.press(screen.getByRole("radio", { name: "6M" }));
  expect(screen.getByLabelText("After 6 months: about $2,061.00, earning $61.00")).toBeVisible();
  await userEvent.clear(amount);
  await userEvent.type(amount, "abc");
  expect(screen.getByRole("alert")).toHaveTextContent(/Enter an amount/);
  expect(screen.getByLabelText("Estimate unavailable")).toBeVisible();
});

test("Deposit stays inside Gizu regardless of provider URLs", async () => {
  const service = mockOpportunityService();
  service.detail.mockResolvedValue({ ...opportunityDetail(1), depositUrl: "javascript:alert(1)" });
  setup(service);
  expect(await screen.findByLabelText("Mainnet vault 1")).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open deposit page" })).toBeNull();
  expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
});
test("featured unsupported vault details are informational and expose no deposit or withdrawal actions", async () => {
  const service = mockOpportunityService();
  service.detail.mockResolvedValue({
    ...opportunityDetail(1),
    featured: true,
    name: "Gizu Prime AUSD",
    protocol: { id: "morpho", name: "Morpho" },
    vaultAddress: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
  } as OpportunityDetail);
  setup(service);
  expect(await screen.findByLabelText("Gizu Prime AUSD")).toBeVisible();
  expect(screen.getByText("Featured vault")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  expect(screen.queryByLabelText("Deposit amount in USD")).toBeNull();
});
test("featuring a supported vault preserves its existing deposit flow", async () => {
  const service = mockOpportunityService();
  service.detail.mockResolvedValue({
    ...opportunityDetail(1),
    featured: true,
    name: "Pendle USDC",
    chainId: 1,
    chain: { name: "Ethereum" },
    vaultAddress: "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
  });
  setup(service);
  expect(await screen.findByLabelText("Pendle USDC")).toBeVisible();
  expect(screen.getByText("Featured vault")).toBeVisible();
  expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
});

test("a deposited vault shows its aggregate amount and routes Withdraw to that vault", async () => {
  const service = mockOpportunityService();
  const profile = earnProfiles["robinhood-usdg"];
  const address = "0x" + "1".repeat(40);
  const portfolio = mainnetPortfolio("owned-vault", address);
  portfolio.positions = [
    {
      assetId: "hood-vault",
      chainId: 4663,
      token: profile.vault,
      symbol: "USDG",
      decimals: 6,
      balanceAtoms: "3000000000000",
      observedAtoms: "3000000000000",
      shareAtoms: "3000000000000",
      underlyingAtoms: "3000000",
      valueUsdcAtoms: "2990000",
      complete: true,
      stale: false,
      checkedAt: Date.now(),
      valuationUnavailable: false,
    },
  ];
  service.detail.mockResolvedValue({
    ...opportunityDetail(1),
    name: "Steakhouse USDG",
    chainId: 4663,
    chain: { name: "Robinhood" },
    vaultAddress: profile.vault,
    tokens: [],
  });
  render(
    <SafeAreaProvider>
      <MainnetWalletProvider
        session={{
          kind: "mainnet",
          method: "Passkey",
          accountId: address,
          address,
          accountIndex: 1,
          chainId: 143,
          walletId: "owned-vault",
        }}
        service={{ getMainnetPortfolio: async () => portfolio }}
      >
        <OpportunityServiceContext.Provider value={service}>
          <NavigationContainer>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen
                name="OpportunityDetail"
                component={OpportunityDetailScreen}
                initialParams={{ id: "op-1" }}
              />
              <Stack.Screen name="VaultPosition">
                {({ route }) => (
                  <Typography>{`Withdrawal for ${route.params.profileId}`}</Typography>
                )}
              </Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        </OpportunityServiceContext.Provider>
      </MainnetWalletProvider>
    </SafeAreaProvider>,
  );
  expect(await screen.findByText("3 USDG deposited")).toBeVisible();
  expect(screen.getByText("≈ 2.99 USDC")).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Withdraw" }));
  expect(await screen.findByText("Withdrawal for robinhood-usdg")).toBeVisible();
});

test("detail failure can be retried and a failed history still shows a flat chart", async () => {
  const service = mockOpportunityService();
  service.detail.mockRejectedValueOnce(new Error("offline"));
  service.tvlRecords.mockRejectedValue(new Error("offline"));
  setup(service);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this vault.");
  expect(screen.queryByLabelText("Mainnet vault 1")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Retry vault" }));
  expect(await screen.findByLabelText("Mainnet vault 1")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(await screen.findByLabelText("TVL history unavailable")).toBeVisible();
  expect(service.detail).toHaveBeenCalledTimes(2);
});

test("a vault without history draws a flat line", async () => {
  const service = mockOpportunityService();
  service.tvlRecords.mockResolvedValue([]);
  setup(service);
  expect(await screen.findByLabelText("No TVL history yet")).toBeVisible();
  expect(screen.queryByText(/no data/i)).toBeNull();
});

test("configured vault detail shows the contract and unavailable metrics without invented prices or history", async () => {
  const service = mockOpportunityService();
  const address = "0x1111111111111111111111111111111111111111";
  const base = opportunityDetail(1);
  service.detail.mockResolvedValue({
    ...base,
    name: "Configured vault",
    symbol: "gzpAUSD",
    protocol: { id: "morpho", name: "Morpho" },
    vaultAddress: address,
    rateType: "apy",
    totalApr: null,
    apr: null,
    tvl: null,
    nativeApr: null,
    dailyRewards: null,
    liveCampaigns: 0,
    campaigns: [],
    tokens: base.tokens.map((token) => ({ ...token, price: null })),
  });
  service.tvlRecords.mockResolvedValue([]);
  setup(service);
  expect(await screen.findByLabelText("Configured vault")).toBeVisible();
  expect(screen.getByLabelText("Morpho logo", { includeHiddenElements: true })).toBeTruthy();
  expect(screen.getByLabelText("Net APY Unavailable")).toBeVisible();
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(2);
  expect(screen.getByLabelText("Estimate unavailable")).toBeVisible();
  expect(screen.queryByLabelText("No TVL history yet")).toBeNull();
  expect(screen.queryByText("$0")).toBeNull();
});

test("returning from vault details retains appended catalog pages without reloading", async () => {
  const service = mockOpportunityService();
  const first = opportunityDetail(1);
  const second = opportunityDetail(2);
  service.list.mockResolvedValueOnce({ list: [first], total: 9, page: 0, items: 8 });
  service.list.mockResolvedValueOnce({ list: [second], total: 9, page: 1, items: 8 });
  service.detail.mockResolvedValue(second);
  render(
    <SafeAreaProvider>
      <OpportunityServiceContext.Provider value={service}>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Main">
              {({ navigation }) => (
                <MainnetVaults onOpen={(id) => navigation.navigate("OpportunityDetail", { id })} />
              )}
            </Stack.Screen>
            <Stack.Screen name="OpportunityDetail" component={OpportunityDetailScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </OpportunityServiceContext.Provider>
    </SafeAreaProvider>,
  );
  await screen.findByText(first.name);
  await userEvent.press(screen.getByRole("button", { name: "Load more" }));
  await userEvent.press(await screen.findByRole("button", { name: `View ${second.name}` }));
  await screen.findByLabelText(second.name);
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByText(first.name)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getByText(second.name)).toBeVisible();
  expect(service.list).toHaveBeenCalledTimes(2);
});
