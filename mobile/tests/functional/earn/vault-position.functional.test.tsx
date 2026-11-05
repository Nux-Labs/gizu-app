import { render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import { EarnProvider } from "@/features/earn/EarnProvider";
import { createEarnInvestmentPositionsService } from "@/services/wallet/investmentPositions";
import { VaultPositionScreen } from "@/features/earn/VaultPositionScreen";
import { parseRobinhoodPlan } from "@/domain/earn/robinhoodExecution";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import type { RootStackParamList } from "@/navigation/types";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnInvestmentPosition } from "@/domain/earn/investmentPositions";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { getStoredEarnWithdrawalSigner } from "@/services/wallet/nativeBridge";
import { exitSnapshot, returnRow } from "../../support/exitCompletion";
jest.mock("@/services/wallet/nativeBridge", () => ({
  ...jest.requireActual("@/services/wallet/nativeBridge"),
  getStoredEarnWithdrawalSigner: jest.fn(),
}));
beforeEach(() => jest.mocked(getStoredEarnWithdrawalSigner).mockReset().mockReturnValue(null));
afterEach(() => jest.restoreAllMocks());
const Stack = createNativeStackNavigator<RootStackParamList>();
const first: EarnIntent = {
  ...hoodIntent,
  intentId: `earn-v1:${hoodIntent.walletId}:robinhood-usdg`,
  distribution: { version: 1, weightsBps: [4300, 5700] },
  investmentSlot: 0,
  destinations: hoodIntent.destinations.map((d, slot) => ({
    ...d,
    role: "invest",
    slot,
  })) as EarnIntent["destinations"],
};
const second: EarnIntent = {
  ...first,
  intentId: `earn-v2:${hoodIntent.walletId}:robinhood-usdg:1`,
  cycleIndex: 1,
};
const other: EarnIntent = {
  ...hoodIntent,
  intentId: `earn-v1:${hoodIntent.walletId}:ethereum-usdc`,
  profileId: "ethereum-usdc",
};
function position(
  intent: EarnIntent,
  slot = 0,
  activity: EarnInvestmentPosition["activity"] = "invested",
): EarnInvestmentPosition {
  return {
    intentId: intent.intentId,
    cycleIndex: intent.cycleIndex ?? 0,
    profileId: intent.profileId,
    investmentSlot: slot,
    activity,
    recoveryRequired: false,
  };
}
function operation(status: SponsoredOperation["status"] = "invested"): SponsoredOperation {
  return {
    operationId: "saved-operation",
    walletId: hoodIntent.walletId,
    revision: 3,
    kind: "hoodDeposit",
    chainId: 4663,
    from: first.destinations[0].address,
    amountAtoms: "1000000",
    nonce: "0x1",
    blocked: status === "unknown",
    canResume: status === "unknown",
    status,
  };
}
function setup(
  options: {
    rows?: EarnInvestmentPosition[];
    cycles?: EarnIntent[];
    pending?: boolean;
    redeemed?: boolean;
    withdrawalPending?: boolean;
    residualAtoms?: string;
  } = {},
) {
  let rows = options.rows ?? [position(first), position(first, 1), position(second)];
  const cycles = options.cycles ?? [first, second, other];
  const listPositions = jest.fn().mockImplementation(async () => rows);
  const select = jest
    .fn()
    .mockImplementation(async (_owner, id) => cycles.find((c) => c.intentId === id));
  let selectedSlot = 0;
  const selectInvestmentSlot = jest.fn().mockImplementation(async (_owner, id, slot) => {
    selectedSlot = slot;
    return { ...cycles.find((c) => c.intentId === id), investmentSlot: slot };
  });
  const prepare = jest.fn();
  const robinhood = {
    available: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([operation(options.pending ? "unknown" : "invested")]),
    plan: jest.fn().mockRejectedValue(new Error("Fresh review unavailable")),
    execute: jest.fn(),
    resume: jest.fn().mockResolvedValue(operation()),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  if (options.redeemed) {
    robinhood.list.mockImplementation(async (intent: EarnIntent) => {
      const slot = intent.investmentSlot ?? 0;
      const from = intent.destinations[slot]!.address;
      return [
        { ...operation("withdrawn"), from, kind: "hoodRedeemAll" },
        { ...returnRow(), from, operationId: `return_${slot}` },
      ];
    });
    jest.mocked(getStoredEarnWithdrawalSigner).mockReturnValue({
      listEarnWithdrawalOperations: jest.fn().mockImplementation(async () => [
        {
          operationId: `paid_${selectedSlot}`,
          walletId: hoodIntent.walletId,
          investmentSlot: selectedSlot,
          returnOperationId: `return_${selectedSlot}`,
          revision: 1,
          kind: "confidentialWithdrawal",
          leg: "withdrawal",
          chainId: 143,
          recipient: "0x" + "8".repeat(40),
          amountAtoms: "899000",
          minimumDestinationAtoms: "880000",
          receivedAtoms: options.withdrawalPending ? "0" : "890000",
          status: options.withdrawalPending ? "pending" : "paid",
          blocked: !!options.withdrawalPending,
          canResume: false,
          ...(!options.withdrawalPending
            ? { destinationTransactionHash: "0x" + "a".repeat(64) }
            : {}),
        },
      ]),
      executeEarnWithdrawal: jest.fn(),
      resumeEarnWithdrawalOperation: jest.fn(),
      cancelEarnWithdrawalOperation: jest.fn(),
      readEarnWithdrawalSettlement: jest.fn(),
      lock: jest.fn(),
    });
    jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const raw = exitSnapshot(Date.now());
      raw.owner = JSON.parse(String(init?.body)).owner;
      raw.balances.tokenAtoms = options.residualAtoms ?? "100000";
      raw.residualUsdcAtoms = raw.balances.tokenAtoms;
      raw.publicResidualReady = BigInt(raw.residualUsdcAtoms) < 500000n;
      return { ok: true, json: async () => raw } as Response;
    });
  }
  const portfolio = mainnetPortfolio(hoodIntent.walletId, hoodIntent.sourceAddress);
  portfolio.positions = [
    {
      assetId: "hood-vault",
      chainId: 4663,
      token: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
      symbol: "USDG",
      decimals: 6,
      balanceAtoms: "3000000",
      observedAtoms: "3000000",
      shareAtoms: "3000000000000000000",
      underlyingAtoms: "3000000",
      complete: true,
      stale: false,
      checkedAt: Date.now(),
      valueUsdcAtoms: "2990000",
      valuationUnavailable: false,
    },
  ];
  render(
    <MainnetWalletProvider
      session={{
        kind: "mainnet",
        walletId: hoodIntent.walletId,
        address: hoodIntent.sourceAddress,
        accountId: hoodIntent.sourceAddress,
        accountIndex: 1,
        method: "Passkey",
        chainId: 143,
      }}
      service={{ getMainnetPortfolio: jest.fn().mockResolvedValue(portfolio) }}
    >
      <EarnProvider
        service={{
          load: jest.fn().mockResolvedValue(other),
          list: jest.fn().mockResolvedValue(cycles),
          select,
          selectInvestmentSlot,
          prepare,
          prepareNew: prepare,
          prepareDistribution: prepare,
          cancel: jest.fn(),
        }}
        investmentPositions={createEarnInvestmentPositionsService(() => ({
          listEarnInvestmentPositions: listPositions,
        }))}
        robinhood={robinhood}
      >
        <NavigationContainer>
          <Stack.Navigator>
            <Stack.Screen
              name="VaultPosition"
              component={VaultPositionScreen}
              initialParams={{ profileId: "robinhood-usdg" }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </EarnProvider>
    </MainnetWalletProvider>,
  );
  return {
    robinhood,
    prepare,
    select,
    selectInvestmentSlot,
    listPositions,
    setRows: (next: EarnInvestmentPosition[]) => {
      rows = next;
    },
  };
}
test("vault withdrawal selects its saved profile and slot, displays one combined position and never funds", async () => {
  const h = setup();
  expect(await screen.findByText("Steakhouse USDG")).toBeVisible();
  expect(await screen.findByText("Deposited: 3 USDG")).toBeVisible();
  expect(screen.getByText("Current value: 2.99 USDC")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Withdraw USDG investment" })).toBeEnabled();
  expect(h.select).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: hoodIntent.walletId }),
    first.intentId,
  );
  expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 0);
  expect(screen.queryByText(/Select wallet/)).toBeNull();
  expect(screen.queryByText(first.destinations[0].address)).toBeNull();
  expect(screen.queryByRole("button", { name: /deposit|funding/i })).toBeNull();
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Withdraw USDG investment" }));
  expect(await screen.findByText("Fresh review unavailable")).toBeVisible();
  expect(h.robinhood.plan).toHaveBeenCalledWith(
    expect.objectContaining({
      intentId: first.intentId,
      profileId: "robinhood-usdg",
      investmentSlot: 0,
    }),
    "hoodRedeemAll",
    expect.anything(),
  );
});
test("completed entries advance sequentially through slots and deposits without automatic signing", async () => {
  const h = setup();
  await screen.findByRole("button", { name: "Withdraw USDG investment" });
  h.setRows([position(first, 0, "returned"), position(first, 1), position(second)]);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  h.setRows([position(first, 0, "returned"), position(first, 1, "returned"), position(second)]);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), second.intentId, 0),
  );
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  h.setRows([
    position(first, 0, "returned"),
    position(first, 1, "returned"),
    position(second, 0, "returned"),
  ]);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  expect(
    await screen.findByText("All saved withdrawals for this vault are complete."),
  ).toBeVisible();
});
test("pending work resumes its saved step and does not repeat a withdrawal", async () => {
  const h = setup({ pending: true, rows: [position(first, 1, "pending")] });
  expect(await screen.findByText("USDG submission awaiting reconciliation")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Withdraw USDG investment" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Review next USDG step" }));
  expect(await screen.findByText("USDG remains invested until you withdraw.")).toBeVisible();
  expect(h.robinhood.resume).toHaveBeenCalledWith(
    expect.objectContaining({ investmentSlot: 1 }),
    expect.objectContaining({ status: "unknown", revision: 3 }),
  );
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
});
test.each([{ rows: [] }, { rows: [position(other)] }])(
  "empty or other-vault inventory never selects or prepares a deposit",
  async ({ rows }) => {
    const h = setup({ rows });
    expect(await screen.findByText("No saved withdrawal activity for this vault.")).toBeVisible();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  },
);
test("foreign saved cycles remain unavailable", async () => {
  const h = setup({ cycles: [{ ...first, walletId: "foreign" }] });
  expect(await screen.findByText(/Saved investment is unavailable for this wallet/)).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
});
test("recovery-required inventory is read-only", async () => {
  const h = setup({ rows: [{ ...position(first), recoveryRequired: true }] });
  expect(
    await screen.findByText(/Restore and reconcile saved activity before withdrawing/),
  ).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.robinhood.list).not.toHaveBeenCalled();
});
test("full withdrawal keeps review and native authorization separate for the exact saved portion", async () => {
  const h = setup();
  const now = Date.now();
  const raw = hoodRaw("hoodRedeemAll", now, "withdraw_saved");
  raw.owner = first.destinations[0].address;
  raw.operation.sender = first.destinations[0].address;
  const plan = parseRobinhoodPlan(raw, first, "hoodRedeemAll", "withdraw_saved", 1, now);
  h.robinhood.plan.mockResolvedValueOnce(plan);
  h.robinhood.execute.mockResolvedValueOnce({ ...operation("withdrawn"), kind: "hoodRedeemAll" });
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw USDG investment" }));
  expect(await screen.findByRole("button", { name: "Authorize USDG withdrawal" })).toBeVisible();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Authorize USDG withdrawal" }));
  expect(
    await screen.findByText("USDG withdrawal confirmed. Return has not been submitted."),
  ).toBeVisible();
  expect(h.robinhood.execute).toHaveBeenCalledWith(
    expect.objectContaining({ intentId: first.intentId, investmentSlot: 0 }),
    plan,
  );
  expect(screen.getByRole("button", { name: "Review USDG return" })).toBeVisible();
  expect(
    screen.getByText(
      "Exit completion verifies this portion of your vault withdrawal before continuing to the next portion.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/Wallet [0-9]/)).toBeNull();
  expect(h.prepare).not.toHaveBeenCalled();
});
test("inventory read failures offer a retry without selecting or funding", async () => {
  const h = setup();
  h.listPositions.mockRejectedValueOnce(new Error("Saved activity temporarily unavailable"));
  expect(await screen.findByText("Saved activity temporarily unavailable")).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  expect(screen.queryByText("No saved withdrawal activity for this vault.")).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  expect(await screen.findByRole("button", { name: "Withdraw USDG investment" })).toBeVisible();
  expect(h.prepare).not.toHaveBeenCalled();
});
test("invalid native inventory identity fails closed before selection", async () => {
  const h = setup({ rows: [{ ...position(first), intentId: "foreign-intent" }] });
  expect(await screen.findByText("Saved vault activity identity changed.")).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.robinhood.list).not.toHaveBeenCalled();
});

test("fresh complete exit and paid receiving withdrawal advance to the next saved portion", async () => {
  const h = setup({ redeemed: true, rows: [position(first, 0, "redeemed"), position(first, 1)] });
  await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
  expect(await screen.findByText(/Investment exit complete:/)).toBeVisible();
  expect(h.selectInvestmentSlot).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test.each([{ residualAtoms: "700000" }, { withdrawalPending: true }])(
  "residual assets or pending receiving withdrawal prevent advancing",
  async (option) => {
    const h = setup({
      ...option,
      redeemed: true,
      rows: [position(first, 0, "redeemed"), position(first, 1)],
    });
    await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
    await screen.findByText(/Investment exit (incomplete|complete):/);
    await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
    expect(h.selectInvestmentSlot).toHaveBeenCalledTimes(1);
  },
);
test("an expired exit proof cannot skip a saved portion", async () => {
  const now = Date.now();
  const h = setup({ redeemed: true, rows: [position(first, 0, "redeemed"), position(first, 1)] });
  await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
  await screen.findByText(/Investment exit complete:/);
  jest.spyOn(Date, "now").mockReturnValue(now + 65000);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  expect(h.selectInvestmentSlot).toHaveBeenCalledTimes(1);
});
test("an explicitly accepted completed portion stays complete while the next portion is reviewed", async () => {
  const now = Date.now();
  const h = setup({
    redeemed: true,
    rows: [position(first, 0, "redeemed"), position(first, 1, "redeemed")],
  });
  await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
  await screen.findByText(/Investment exit complete:/);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  jest.spyOn(Date, "now").mockReturnValue(now + 65000);
  await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
  expect(h.selectInvestmentSlot).toHaveBeenCalledTimes(2);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test.each(["invested", "pending"] as const)(
  "new %s native activity revokes an accepted completed portion",
  async (activity) => {
    const h = setup({
      redeemed: true,
      rows: [position(first, 0, "redeemed"), position(first, 1, "redeemed")],
    });
    await userEvent.press(await screen.findByRole("button", { name: "Check exit completion" }));
    await screen.findByText(/Investment exit complete:/);
    await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
    await waitFor(() =>
      expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
    );
    h.setRows([position(first, 0, activity), position(first, 1, "redeemed")]);
    await userEvent.press(screen.getByRole("button", { name: "Check vault withdrawal progress" }));
    await waitFor(() =>
      expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), first.intentId, 0),
    );
    expect(h.robinhood.execute).not.toHaveBeenCalled();
  },
);
