import { render, screen, userEvent } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import type { EarnIntent } from "@/domain/earn/types";
import { EarnProvider, useEarn } from "@/features/earn/EarnProvider";
import { EarnInvestmentScreen } from "@/features/earn/EarnInvestmentScreen";
import { LegacyEthereumDepositScreen } from "@/features/earn/LegacyEthereumDepositScreen";
import { hoodIntent } from "../../support/robinhoodEarn";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import type { RootStackParamList } from "@/navigation/types";
const Stack = createNativeStackNavigator<RootStackParamList>();
const intent = {
  ...hoodIntent,
  profileId: "ethereum-usdc" as const,
  destinations: hoodIntent.destinations.map((d) => ({
    ...d,
    chainId: 1,
  })) as typeof hoodIntent.destinations,
};
function SelectedDeposit() {
  const { state } = useEarn();
  return state && "intentId" in state ? (
    <LegacyEthereumDepositScreen
      key={`${state.intentId}:${state.investmentSlot ?? "legacy"}`}
      intent={state}
    />
  ) : null;
}
function setup(enabled = true, savedIntent: EarnIntent = intent, resumeSaved = false) {
  let current = savedIntent;
  const filledSlots = new Set<number | undefined>(),
    investedSlots = new Set<number | undefined>();
  const legs = savedIntent.distribution
    ? savedIntent.destinations.map((_, slot) => `invest:${slot}`)
    : ["hold", "invest"];
  let funded = resumeSaved,
    paid = resumeSaved ? legs.length : 0;
  if (resumeSaved) {
    filledSlots.add(0);
    investedSlots.add(0);
  }
  const funding = {
    operationId: "source_1",
    walletId: intent.walletId,
    kind: "sourceFunding",
    status: "credited",
    blocked: false,
    creditedAtoms: "2970000",
    sourceAccountIndex: 1,
  };
  const source = {
    available: jest.fn().mockResolvedValue(enabled),
    list: jest.fn().mockImplementation(async () => (funded ? [funding] : [])),
    planMany: jest.fn().mockResolvedValue([{ budget: "3000000", expiresAtMs: Date.now() + 45000 }]),
    executeMany: jest.fn().mockImplementation(async () => {
      funded = true;
      return [funding];
    }),
    plan: jest.fn(),
    execute: jest.fn(),
    resume: jest.fn(),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const payout = {
    available: jest.fn().mockResolvedValue(enabled),
    list: jest.fn().mockImplementation(async () =>
      legs.slice(0, paid).map((leg) => ({
        sourceOperationId: "source_1",
        operationId: `payout_${leg}`,
        leg,
        status: "paid",
        amountAtoms: "1000000",
        minimumDestinationAtoms: "900000",
        receivedAtoms: "900000",
      })),
    ),
    execute: jest.fn().mockImplementation(async () => {
      paid++;
    }),
    resume: jest.fn(),
    reconcile: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const liquidity = {
    available: jest.fn().mockResolvedValue(enabled),
    list: jest.fn().mockImplementation(async (selected: EarnIntent) =>
      filledSlots.has(selected.investmentSlot)
        ? [
            {
              kind: "fusionEthOrder",
              status: "fusionFilled",
              operationId: `liquidity_${selected.investmentSlot}`,
              amountAtoms: "100000",
            },
          ]
        : [],
    ),
    bootstrap: jest.fn().mockResolvedValue({
      proposal: { kind: "fusionEthOrder", inputAtoms: "100000" },
      expiresAtMs: Date.now() + 45000,
    }),
    execute: jest.fn().mockImplementation(async (selected: EarnIntent) => {
      filledSlots.add(selected.investmentSlot);
    }),
    resume: jest.fn(),
    returnPlan: jest.fn(),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancelPending: jest.fn(),
    cancel: jest.fn(),
  };
  const vault = {
    available: jest.fn().mockResolvedValue(enabled),
    list: jest.fn().mockImplementation(async (selected: EarnIntent) =>
      investedSlots.has(selected.investmentSlot)
        ? [
            {
              status: "invested",
              operationId: `vault_${selected.investmentSlot}`,
              actualFeeWei: "0",
              steps: [],
            },
          ]
        : [],
    ),
    plan: jest.fn().mockImplementation(async (selected: EarnIntent) => ({
      amountAtoms: "2500000",
      fusionRequired: !filledSlots.has(selected.investmentSlot),
      maximumGasCostWei: "100",
      withdrawalReserveWei: "200",
      expiresAtMs: Date.now() + 45000,
    })),
    execute: jest.fn().mockImplementation(async (selected: EarnIntent) => {
      investedSlots.add(selected.investmentSlot);
    }),
    resume: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  const selectInvestmentSlot = jest.fn().mockImplementation(async (_owner, _id, slot: number) => {
    current = { ...current, investmentSlot: slot };
    return current;
  });
  render(
    <MainnetWalletProvider
      session={{
        kind: "mainnet",
        walletId: intent.walletId,
        address: intent.sourceAddress,
        accountId: intent.sourceAddress,
        accountIndex: 1,
        method: "Passkey",
        chainId: 143,
      }}
      service={{
        getMainnetPortfolio: jest
          .fn()
          .mockResolvedValue(mainnetPortfolio(intent.walletId, intent.sourceAddress)),
      }}
    >
      <EarnProvider
        service={{
          load: jest.fn().mockImplementation(async () => current),
          list: jest.fn().mockImplementation(async () => [current]),
          selectInvestmentSlot,
          prepare: jest.fn(),
          cancel: jest.fn(),
        }}
        sourceFunding={source}
        payout={payout}
        liquidity={liquidity}
        vaultExecution={vault}
      >
        <NavigationContainer>
          <Stack.Navigator>
            {resumeSaved ? (
              <Stack.Screen
                name="EarnInvestment"
                initialParams={{ intentId: savedIntent.intentId }}
                component={EarnInvestmentScreen}
              />
            ) : (
              <Stack.Screen name="Earn">{() => <SelectedDeposit />}</Stack.Screen>
            )}
          </Stack.Navigator>
        </NavigationContainer>
      </EarnProvider>
    </MainnetWalletProvider>,
  );
  return { source, payout, liquidity, vault, selectInvestmentSlot };
}
test("Ethereum reuses funding, payout, liquidity and vault services in order and stops invested", async () => {
  const { source, payout, liquidity, vault } = setup();
  const user = userEvent.setup();
  expect(await screen.findByText(/separate native approvals/)).toBeVisible();
  await user.type(screen.getByLabelText("USDC deposit amount"), "3");
  await user.press(screen.getByRole("button", { name: "Review USDC funding" }));
  expect(source.planMany).toHaveBeenCalledWith(
    intent,
    "3000000",
    expect.stringMatching(/^[0-9]+$/),
    expect.anything(),
  );
  await user.press(await screen.findByRole("button", { name: "Authorize USDC funding" }));
  expect(vault.plan).not.toHaveBeenCalled();
  await user.press(
    await screen.findByRole("button", { name: "Review and authorize 10% hold payout" }),
  );
  await user.press(
    await screen.findByRole("button", { name: "Review and authorize 90% investment payout" }),
  );
  expect(payout.execute).toHaveBeenNthCalledWith(
    1,
    intent,
    expect.objectContaining({ operationId: "source_1" }),
    "hold",
  );
  expect(payout.execute).toHaveBeenNthCalledWith(
    2,
    intent,
    expect.objectContaining({ operationId: "source_1" }),
    "invest",
  );
  await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
  await user.press(await screen.findByRole("button", { name: "Authorize ETH funding" }));
  expect(vault.execute).not.toHaveBeenCalled();
  await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
  await user.press(await screen.findByRole("button", { name: "Authorize vault deposit" }));
  expect(await screen.findByText("Invested")).toBeVisible();
  expect(liquidity.execute).toHaveBeenCalledTimes(1);
  expect(vault.execute).toHaveBeenCalledTimes(1);
  expect(vault.plan.mock.calls.every((call) => call[1] === "vaultDeposit")).toBe(true);
  expect(liquidity.returnPlan).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Withdraw/i })).toBeNull();
});
test("an unsupported Ethereum signer never receives a Robinhood coordinator substitute", async () => {
  const { source, vault } = setup(false);
  expect(
    await screen.findByText("This build does not support native Ethereum deposits."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Review USDC funding" })).toBeDisabled();
  expect(source.planMany).not.toHaveBeenCalled();
  expect(vault.execute).not.toHaveBeenCalled();
});

test("Ethereum invests every distributed wallet without repeating funding or successful payouts", async () => {
  const distributed: EarnIntent = {
    ...intent,
    distribution: { version: 1, weightsBps: [4300, 5700] },
    distributionBudgetAtoms: "3000000",
    investmentSlot: 0,
    destinations: [
      { role: "invest", slot: 0, chainId: 1, address: "0x" + "5".repeat(40) },
      { role: "invest", slot: 1, chainId: 1, address: "0x" + "6".repeat(40) },
    ],
  };
  const { source, payout, liquidity, vault, selectInvestmentSlot } = setup(true, distributed);
  const user = userEvent.setup();
  await user.press(await screen.findByRole("button", { name: "Review USDC funding" }));
  expect(screen.getByText("Source budget: 3 USDC")).toBeVisible();
  await user.press(await screen.findByRole("button", { name: "Authorize USDC funding" }));
  for (const wallet of [1, 2]) {
    await user.press(
      await screen.findByRole("button", { name: `Review and authorize wallet ${wallet} payout` }),
    );
  }
  expect(payout.execute.mock.calls.map((call) => call[2])).toEqual(["invest:0", "invest:1"]);
  for (const slot of [0, 1]) {
    await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
    await user.press(await screen.findByRole("button", { name: "Authorize ETH funding" }));
    await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
    await user.press(await screen.findByRole("button", { name: "Authorize vault deposit" }));
    expect(await screen.findByText(`Wallet ${slot + 1} invested`)).toBeVisible();
    if (slot === 0) {
      await user.press(screen.getByRole("button", { name: "Continue with wallet 2" }));
      expect(selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), distributed.intentId, 1);
    }
  }
  expect(source.planMany).toHaveBeenCalledTimes(1);
  expect(source.executeMany).toHaveBeenCalledTimes(1);
  expect(payout.execute).toHaveBeenCalledTimes(2);
  expect(liquidity.execute.mock.calls.map((call) => call[0].investmentSlot)).toEqual([0, 1]);
  expect(vault.execute.mock.calls.map((call) => call[0].investmentSlot)).toEqual([0, 1]);
  expect(screen.queryByRole("button", { name: /Continue with wallet/ })).toBeNull();
});

test("a reopened Ethereum distribution continues the unfinished wallet from saved investment", async () => {
  const distributed: EarnIntent = {
    ...intent,
    distribution: { version: 1, weightsBps: [4300, 5700] },
    distributionBudgetAtoms: "3000000",
    investmentSlot: 0,
    destinations: [
      { role: "invest", slot: 0, chainId: 1, address: "0x" + "5".repeat(40) },
      { role: "invest", slot: 1, chainId: 1, address: "0x" + "6".repeat(40) },
    ],
  };
  const { source, payout, liquidity, vault } = setup(true, distributed, true);
  const user = userEvent.setup();
  await user.press(await screen.findByRole("button", { name: "Open saved deposit progress" }));
  expect(await screen.findByText("Wallet 1 invested")).toBeVisible();
  await user.press(screen.getByRole("button", { name: "Continue with wallet 2" }));
  await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
  await user.press(await screen.findByRole("button", { name: "Authorize ETH funding" }));
  await user.press(await screen.findByRole("button", { name: "Review vault deposit" }));
  await user.press(await screen.findByRole("button", { name: "Authorize vault deposit" }));
  expect(await screen.findByText("Wallet 2 invested")).toBeVisible();
  expect(source.planMany).not.toHaveBeenCalled();
  expect(source.executeMany).not.toHaveBeenCalled();
  expect(payout.execute).not.toHaveBeenCalled();
  expect(vault.execute.mock.calls.map((call) => call[0].investmentSlot)).toEqual([1]);
  expect(liquidity.execute.mock.calls.map((call) => call[0].investmentSlot)).toEqual([1]);
  await user.press(screen.getByRole("button", { name: "View investment" }));
  expect(await screen.findByText("Saved investment")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Withdraw investment" })).toBeVisible();
});
