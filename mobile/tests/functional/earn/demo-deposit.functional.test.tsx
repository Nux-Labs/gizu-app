import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { DepositJourneyScreen } from "@/features/earn/DepositJourneyScreen";
import { EarnScreen } from "@/features/earn/EarnScreen";
import { OpportunityDetailScreen } from "@/features/opportunities/OpportunityDetailScreen";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import type { RootStackParamList } from "@/navigation/types";
import { getStoredEarnDepositSigner } from "@/services/wallet/nativeBridge";
import { swapDemo } from "@/features/swap/demo/swapDemo";
import { demoVaults } from "@/services/demo/vaults";
import { demoVaultMetadata } from "@/services/demo/opportunities";
import { OpportunityServiceContext } from "@/features/opportunities/useOpportunities";
import { opportunityService } from "@/services/opportunities";

jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredEarnDepositSigner: jest.fn(() => {
    throw new Error("Unexpected native deposit");
  }),
  getStoredSwapSigner: jest.fn(() => {
    throw new Error("Unexpected native portfolio");
  }),
}));

const Stack = createNativeStackNavigator<RootStackParamList>();
const originalFlag = process.env.EXPO_PUBLIC_SWAP_DEMO;
const session = {
  kind: "mainnet" as const,
  method: "Passkey" as const,
  accountId: "demo",
  address: "0x" + "1".repeat(40),
  accountIndex: 1 as const,
  chainId: 143 as const,
  walletId: "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
};

beforeEach(() => {
  process.env.EXPO_PUBLIC_SWAP_DEMO = "1";
  swapDemo.reset();
  demoVaults.reset();
});
afterEach(() => {
  swapDemo.reset();
  demoVaults.reset();
  jest.useRealTimers();
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_SWAP_DEMO;
  else process.env.EXPO_PUBLIC_SWAP_DEMO = originalFlag;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

function setup(opportunityId?: string) {
  return render(
    <MainnetWalletProvider session={session}>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {opportunityId && (
            <Stack.Screen
              name="OpportunityDetail"
              component={OpportunityDetailScreen}
              initialParams={{ id: opportunityId }}
            />
          )}
          <Stack.Screen name="Earn">
            {(props) =>
              opportunityId ? (
                <EarnScreen {...props} />
              ) : (
                <DepositJourneyScreen profileId="robinhood-usdg" />
              )
            }
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </MainnetWalletProvider>,
  );
}

test("demo deposit requires a valid affordable amount and reviews without native calls", async () => {
  const network = jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network"));
  setup();
  await screen.findByText("Available: 250 USDC");
  expect(screen.queryByText(/Two fresh wallets/)).toBeNull();
  expect(screen.queryByText(/This build does not support/)).toBeNull();
  const input = screen.getByLabelText("USDC deposit amount");
  const button = () => screen.getByRole("button", { name: "Review deposit" });
  expect(button()).toBeDisabled();
  for (const invalid of ["0", "-1", "abc", "1.1234567", "250.000001"]) {
    fireEvent.changeText(input, invalid);
    expect(button()).toBeDisabled();
  }
  expect(screen.getByText("Enter an amount within your available USDC.")).toBeVisible();
  for (const valid of ["0.000002", "100", "250", "10,5"]) {
    fireEvent.changeText(input, valid);
    expect(button()).toBeEnabled();
  }
  fireEvent.press(button());
  expect(screen.getByText("10.5 USDC")).toBeVisible();
  expect(screen.getByText("Steakhouse USDG")).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeEnabled();
  fireEvent.press(screen.getByRole("button", { name: "Edit amount" }));
  fireEvent.changeText(screen.getByLabelText("USDC deposit amount"), "0");
  expect(button()).toBeDisabled();
  expect(getStoredEarnDepositSigner).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

test.each([
  ["demo-morpho-steakhouse-usdg", "Steakhouse USDG"],
  ["demo-aave-usdc", "Aave V3 USDC"],
  ["demo-curvance-high-yield-ausd", "High Yield AUSD"],
])("demo vault %s opens its own deposit preview", async (id, name) => {
  const network = jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network"));
  setup(id);
  const deposit = await screen.findByRole("button", { name: "Deposit" });
  expect(deposit).toBeEnabled();
  fireEvent.press(deposit);
  await screen.findByLabelText("USDC deposit amount");
  await screen.findByText("Available: 250 USDC");
  expect(screen.getByText(name)).toBeVisible();
  fireEvent.changeText(screen.getByLabelText("USDC deposit amount"), "25");
  fireEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(screen.getByText(name)).toBeVisible();
  expect(getStoredEarnDepositSigner).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

test("a catalog type change does not disable a registered demo vault", async () => {
  const vault = demoVaultMetadata("demo-morpho-steakhouse-usdg")!;
  render(
    <OpportunityServiceContext.Provider
      value={{
        ...opportunityService,
        detail: async () => ({ ...vault, type: "LENDING" }),
      }}
    >
      <MainnetWalletProvider session={session}>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen
              name="OpportunityDetail"
              component={OpportunityDetailScreen}
              initialParams={{ id: vault.id }}
            />
            <Stack.Screen name="Earn" component={EarnScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </MainnetWalletProvider>
    </OpportunityServiceContext.Provider>,
  );
  const button = await screen.findByRole("button", { name: "Deposit" });
  expect(button).toBeEnabled();
  expect(screen.queryByText("In-app deposits are not supported for this vault.")).toBeNull();
  fireEvent.press(button);
  await screen.findByLabelText("USDC deposit amount");
});

test("confirmation deducts cash and updates the selected position exactly once", async () => {
  jest.useFakeTimers();
  setup("demo-morpho-steakhouse-usdg");
  fireEvent.press(await screen.findByRole("button", { name: "Deposit" }));
  const input = await screen.findByLabelText("USDC deposit amount");
  await screen.findByText("Available: 250 USDC");
  fireEvent.changeText(input, "100");
  fireEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(screen.getByText("99.9 USDC")).toBeVisible();
  expect(screen.getByText("0.1 USDC")).toBeVisible();
  const confirm = screen.getByRole("button", { name: "Confirm deposit" });
  await act(async () => {
    fireEvent.press(confirm);
    fireEvent.press(confirm);
    await jest.advanceTimersByTimeAsync(700);
  });
  expect(screen.getByText("Deposit complete")).toBeVisible();
  expect(swapDemo.usdcAtoms()).toBe(150000000n);
  expect(
    demoVaults.balance(
      { walletId: session.walletId, address: session.address },
      "demo-morpho-steakhouse-usdg",
    ),
  ).toBe("349900000");
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  fireEvent.press(await screen.findByRole("button", { name: "Deposit" }));
  expect(await screen.findByText("Available: 150 USDC")).toBeVisible();
  expect(getStoredEarnDepositSigner).not.toHaveBeenCalled();
});

test("Max deposits can use the full cash budget and end without a balance error", async () => {
  jest.useFakeTimers();
  setup();
  await screen.findByText("Available: 250 USDC");
  fireEvent.press(screen.getByRole("button", { name: "Max" }));
  expect(screen.getByDisplayValue("250")).toBeVisible();
  fireEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Confirm deposit" }));
    await jest.advanceTimersByTimeAsync(700);
  });
  expect(screen.getByText("Deposit complete")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(swapDemo.usdcAtoms()).toBe(0n);
});

test("an expired deposit review can be edited and refreshed without spending", async () => {
  jest.useFakeTimers();
  setup();
  await screen.findByText("Available: 250 USDC");
  fireEvent.changeText(screen.getByLabelText("USDC deposit amount"), "20");
  fireEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60001);
  });
  fireEvent.press(screen.getByRole("button", { name: "Confirm deposit" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/estimate expired/);
  expect(swapDemo.usdcAtoms()).toBe(250000000n);
  fireEvent.press(screen.getByRole("button", { name: "Edit amount" }));
  fireEvent.press(screen.getByRole("button", { name: "Review deposit" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
