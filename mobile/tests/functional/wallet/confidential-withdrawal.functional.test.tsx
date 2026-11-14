import { act, render, screen, userEvent } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import {
  ConfidentialWithdrawalScreen,
  ConfidentialWithdrawalServiceContext,
} from "@/features/wallet/ConfidentialWithdrawalScreen";
import type { ConfidentialWithdrawal } from "@/domain/wallet/confidentialWithdrawal";
import type { RootStackParamList } from "@/navigation/types";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { deferred } from "../../support/renderApp";

const Stack = createNativeStackNavigator<RootStackParamList>();
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const address = "0x" + "1".repeat(40);
function plan(): ConfidentialWithdrawal {
  return {
    walletId,
    operationId: "cashout_1",
    revision: 1,
    amountAtoms: "10000000",
    minimumDestinationAtoms: "9800000",
    receivedAtoms: "0",
    walletCount: 2,
    weightsBps: [6000, 4000],
    status: "review",
    canResume: true,
    canCancel: true,
    payouts: [
      {
        slot: 0,
        amountAtoms: "6000000",
        minimumDestinationAtoms: "5900000",
        receivedAtoms: "0",
        status: "review",
      },
      {
        slot: 1,
        amountAtoms: "4000000",
        minimumDestinationAtoms: "3900000",
        receivedAtoms: "0",
        status: "review",
      },
    ],
  };
}
function setup(initial: ConfidentialWithdrawal | null = null, available = true) {
  const service = {
    available: jest.fn().mockResolvedValue(available),
    read: jest.fn().mockResolvedValue(initial),
    prepare: jest.fn().mockResolvedValue(plan()),
    execute: jest.fn().mockResolvedValue({ ...plan(), status: "unknown", canCancel: false }),
    resume: jest.fn().mockResolvedValue({ ...plan(), status: "pending", canCancel: false }),
    cancel: jest
      .fn()
      .mockResolvedValue({ ...plan(), status: "cancelled", canCancel: false, canResume: false }),
  };
  const portfolio = mainnetPortfolio(walletId, address, "25000000");
  portfolio.ownedAssets = [
    {
      assetId: "private-usdc",
      chainId: 143,
      token: "confidential:monad-usdc",
      symbol: "USDC (private)",
      decimals: 6,
      balanceAtoms: "10000000",
      observedAtoms: "10000000",
      valueUsdcAtoms: "10000000",
      checkedAt: Date.now(),
      complete: true,
      stale: false,
      valuationUnavailable: false,
    },
  ];
  const readPortfolio = jest.fn().mockResolvedValue(portfolio);
  const contents = (currentService = service) => (
    <MainnetWalletProvider
      session={{
        kind: "mainnet",
        method: "Passkey",
        walletId,
        accountId: address,
        address,
        accountIndex: 1,
        chainId: 143,
      }}
      service={{ getMainnetPortfolio: readPortfolio }}
    >
      <ConfidentialWithdrawalServiceContext.Provider value={currentService}>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="ConfidentialWithdrawal" component={ConfidentialWithdrawalScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </ConfidentialWithdrawalServiceContext.Provider>
    </MainnetWalletProvider>
  );
  const view = render(contents());
  return {
    service,
    readPortfolio,
    view,
    changeService: (next: typeof service) => view.rerender(contents(next)),
  };
}
test("chosen private debit receives an immutable distributed native review before authorization", async () => {
  const h = setup();
  expect(await screen.findByText("10 USDC")).toBeVisible();
  await userEvent.type(screen.getByLabelText("Withdrawal amount in USDC"), "10");
  await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
  expect(h.service.prepare).toHaveBeenCalledWith("10000000");
  expect(await screen.findByText("Receiving wallets · 2")).toBeVisible();
  expect(screen.getByText("Minimum received")).toBeVisible();
  expect(screen.getByText("9.8 USDC")).toBeVisible();
  expect(screen.queryByText("Received so far")).toBeNull();
  expect(h.service.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Authorize public withdrawal" }));
  expect(h.service.execute).toHaveBeenCalledWith(plan());
  expect(await screen.findByText("Confirmation needed")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Resume saved withdrawal" }));
  expect(h.service.resume).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "cashout_1" }),
  );
  expect(h.service.prepare).toHaveBeenCalledTimes(1);
});
test("invalid amount does not create a withdrawal or use public balance as private cash", async () => {
  const h = setup();
  await screen.findByLabelText("Withdrawal amount in USDC");
  await userEvent.type(screen.getByLabelText("Withdrawal amount in USDC"), "1.0000001");
  expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
  expect(h.service.prepare).not.toHaveBeenCalled();
  expect(screen.queryByText("25 USDC")).toBeNull();
});
test("saved uncertain withdrawal is resumed rather than allocating more receiving wallets", async () => {
  const h = setup({ ...plan(), status: "unknown", canCancel: false });
  expect(await screen.findByText("Confirmation needed")).toBeVisible();
  expect(screen.queryByLabelText("Withdrawal amount in USDC")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Resume saved withdrawal" }));
  expect(h.service.resume).toHaveBeenCalledTimes(1);
  expect(h.service.prepare).not.toHaveBeenCalled();
});
test("an unsigned quote failure retains its saved distribution and can be cancelled without authorizing", async () => {
  const draft = {
    ...plan(),
    status: "needsReview" as const,
    minimumDestinationAtoms: "0",
    payouts: plan().payouts.map((p) => ({
      ...p,
      status: "needsReview" as const,
      minimumDestinationAtoms: "0",
    })),
  };
  const h = setup(draft);
  expect(await screen.findByText("A new payout quote is needed.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Authorize public withdrawal" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Cancel unsigned withdrawal" }));
  expect(h.service.cancel).toHaveBeenCalledWith(draft);
  expect(await screen.findByLabelText("Withdrawal amount in USDC")).toBeVisible();
  expect(h.service.prepare).not.toHaveBeenCalled();
  expect(h.service.execute).not.toHaveBeenCalled();
});
test("a rejected native approval reloads the saved plan without generating new recipients", async () => {
  const h = setup(plan());
  h.service.execute.mockRejectedValueOnce(new Error("Native approval cancelled."));
  await userEvent.press(await screen.findByRole("button", { name: "Authorize public withdrawal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Native approval cancelled.");
  expect(screen.getByText("Receiving wallets · 2")).toBeVisible();
  expect(h.service.prepare).not.toHaveBeenCalled();
  expect(h.service.read).toHaveBeenCalledTimes(2);
});
test("a later quote failure preserves completed payout progress and permits resume", async () => {
  const partial: ConfidentialWithdrawal = {
    ...plan(),
    status: "needsReview",
    canCancel: false,
    minimumDestinationAtoms: "5900000",
    receivedAtoms: "5950000",
    payouts: [
      { ...plan().payouts[0]!, status: "paid", receivedAtoms: "5950000" },
      { ...plan().payouts[1]!, status: "needsReview", minimumDestinationAtoms: "0" },
    ],
  };
  const h = setup(partial);
  expect(
    await screen.findByText("Review remaining payouts. Completed payouts stay complete."),
  ).toBeVisible();
  expect(screen.getByText("Received so far")).toBeVisible();
  expect(screen.getByText("5.95 USDC")).toBeVisible();
  expect(screen.queryByText("Receiving wallet 1 · paid")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Withdrawal recipients" }));
  expect(screen.getByText("Receiving wallet 1 · paid")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Authorize public withdrawal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel unsigned withdrawal" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Resume saved withdrawal" }));
  expect(h.service.resume).toHaveBeenCalledWith(partial);
  expect(h.service.prepare).not.toHaveBeenCalled();
});
test("rejected preparation remains explicit and never invokes payout authorization", async () => {
  const h = setup();
  h.service.prepare.mockRejectedValueOnce(
    new Error("Private funds are reserved by another operation."),
  );
  await userEvent.type(await screen.findByLabelText("Withdrawal amount in USDC"), "10");
  await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Private funds are reserved by another operation.",
  );
  expect(h.service.execute).not.toHaveBeenCalled();
});
test("unsupported native build has no actionable withdrawal", async () => {
  const h = setup(null, false);
  expect(await screen.findByText("Requires an updated Android app.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  expect(h.service.prepare).not.toHaveBeenCalled();
});
test("late native preparation is ignored after the screen closes", async () => {
  const h = setup();
  const pending = deferred<ConfidentialWithdrawal>();
  h.service.prepare.mockReturnValueOnce(pending.promise);
  await userEvent.type(await screen.findByLabelText("Withdrawal amount in USDC"), "10");
  await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
  h.view.unmount();
  await act(async () => pending.resolve(plan()));
  expect(h.service.execute).not.toHaveBeenCalled();
});
test("changing the wallet service clears an old busy operation and ignores its late reply", async () => {
  const h = setup(plan());
  const pending = deferred<ConfidentialWithdrawal>();
  h.service.execute.mockReturnValueOnce(pending.promise);
  await userEvent.press(await screen.findByRole("button", { name: "Authorize public withdrawal" }));
  expect(screen.getByRole("button", { name: "Authorize public withdrawal" })).toBeDisabled();
  const replacement = { ...h.service, read: jest.fn().mockResolvedValue(null) };
  h.changeService(replacement);
  const input = await screen.findByLabelText("Withdrawal amount in USDC");
  await userEvent.type(input, "1");
  expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeEnabled();
  await act(async () => pending.resolve({ ...plan(), status: "unknown", canCancel: false }));
  expect(screen.queryByText("Confirmation needed")).toBeNull();
});
