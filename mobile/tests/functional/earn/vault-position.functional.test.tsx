import { render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { MainnetWalletProvider } from "@/features/wallet/MainnetWalletProvider";
import { EarnProvider } from "@/features/earn/EarnProvider";
import { createEarnInvestmentPositionsService } from "@/services/wallet/investmentPositions";
import { VaultPositionScreen } from "@/features/earn/VaultPositionScreen";
import { VaultWithdrawalScreen } from "@/features/earn/VaultWithdrawalScreen";
import { parseRobinhoodPlan } from "@/domain/earn/robinhoodExecution";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import type { RootStackParamList } from "@/navigation/types";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnInvestmentPosition } from "@/domain/earn/investmentPositions";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { getStoredEarnWithdrawalSigner } from "@/services/wallet/nativeBridge";
import { exitSnapshot, returnRow, minimumReturnRow } from "../../support/exitCompletion";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createEarnRobinhoodService } from "@/services/earn/robinhoodExecution";
import type { EarnRobinhoodService } from "@/domain/earn/robinhoodExecution";
jest.mock("@/services/wallet/nativeBridge", () => ({
  ...jest.requireActual("@/services/wallet/nativeBridge"),
  getStoredEarnWithdrawalSigner: jest.fn(),
  getSignerCapabilities: jest.fn().mockResolvedValue({ earnSponsoredExecution: true }),
}));
beforeEach(async () => {
  jest.mocked(getStoredEarnWithdrawalSigner).mockReset().mockReturnValue(null);
  await AsyncStorage.clear();
});
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
    overview?: boolean;
    rows?: EarnInvestmentPosition[];
    cycles?: EarnIntent[];
    pending?: boolean;
    redeemed?: boolean;
    withdrawalPending?: boolean;
    residualAtoms?: string;
    privateOnly?: boolean;
    savedOperations?: SponsoredOperation[];
    robinhoodService?: EarnRobinhoodService;
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
    list: jest
      .fn()
      .mockResolvedValue(
        options.savedOperations ?? [operation(options.pending ? "unknown" : "invested")],
      ),
    plan: jest.fn().mockRejectedValue(new Error("Fresh review unavailable")),
    execute: jest.fn(),
    resume: jest.fn().mockResolvedValue(operation()),
    reconcileCredit: jest.fn(),
    cancelUnsigned: jest.fn(),
    cancel: jest.fn(),
  };
  if (options.privateOnly) {
    jest.mocked(getStoredEarnWithdrawalSigner).mockReturnValue({
      listEarnWithdrawalOperations: jest.fn().mockResolvedValue([]),
      executeEarnWithdrawal: jest.fn(),
      resumeEarnWithdrawalOperation: jest.fn(),
      cancelEarnWithdrawalOperation: jest.fn(),
      readEarnWithdrawalSettlement: jest.fn(),
      lock: jest.fn(),
    });
  }
  if (options.redeemed) {
    robinhood.list.mockImplementation(async (intent: EarnIntent) => {
      const slot = intent.investmentSlot ?? 0;
      const from = intent.destinations[slot]!.address;
      if (
        rows.find((row) => row.intentId === intent.intentId && row.investmentSlot === slot)
          ?.activity !== "redeemed"
      )
        return [{ ...operation(), from }];
      return [
        { ...operation("withdrawn"), from, kind: "hoodRedeemAll" },
        { ...returnRow(), from, operationId: `return_${slot}` },
      ];
    });
    jest.mocked(getStoredEarnWithdrawalSigner).mockReturnValue({
      listEarnWithdrawalOperations: jest.fn().mockImplementation(async () =>
        options.privateOnly
          ? []
          : [
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
            ],
      ),
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
        robinhood={options.robinhoodService ?? robinhood}
      >
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={options.overview ? "VaultPosition" : "VaultWithdrawal"}
          >
            <Stack.Screen
              name="VaultPosition"
              component={VaultPositionScreen}
              initialParams={{ profileId: "robinhood-usdg" }}
            />
            <Stack.Screen
              name="VaultWithdrawal"
              component={VaultWithdrawalScreen}
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
test("a distributed saved withdrawal can be replaced with a fresh review through the real journal adapter", async () => {
  const saved = {
    ...operation(),
    from: second.destinations[1]!.address,
    kind: "hoodRedeemAll",
    investmentSlot: 1,
    cycleIndex: 1,
    status: "authorizationSaved",
    blocked: true,
    canResume: true,
    canCancelPreparation: true,
  };
  const native = {
    executeEarnSponsored: jest.fn(),
    listEarnSponsoredOperations: jest.fn().mockResolvedValue([saved]),
    cancelEarnSponsoredOperation: jest.fn().mockImplementation(async () => ({
      ...saved,
      status: "cancelled",
      blocked: false,
      canResume: false,
    })),
    resumeEarnSponsoredOperation: jest.fn(),
    readEarnSponsoredSettlement: jest.fn(),
    prepareEarnSourceQuote: jest.fn(),
    lock: jest.fn(),
  };
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => hoodRaw("hoodRedeemAll", Date.now(), body.operationId, body.revision),
    } as Response;
  });
  setup({
    rows: [position(second, 1)],
    robinhoodService: createEarnRobinhoodService("https://backend.test", () => native),
  });
  await userEvent.press(await screen.findByRole("button", { name: "Start a fresh review" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  expect(native.cancelEarnSponsoredOperation).toHaveBeenCalledWith(
    hoodIntent.walletId,
    saved.operationId,
    3,
  );
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  expect(screen.queryByText(/different investment wallet/)).toBeNull();
});
test("opening an invested position does not reopen an older private return or select its cycle", async () => {
  const h = setup({
    overview: true,
    rows: [position(first, 0, "redeemed"), position(second)],
    savedOperations: [
      { ...operation("withdrawn"), kind: "hoodRedeemAll" },
      { ...minimumReturnRow(), from: first.destinations[0].address },
    ],
  });
  expect(await screen.findByText(/3 USDG/)).toBeVisible();
  expect(await screen.findByRole("button", { name: "Withdraw" })).toBeEnabled();
  expect(screen.queryByText("Return to private balance")).toBeNull();
  expect(screen.queryByText("STEP 2 OF 2")).toBeNull();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.listPositions).not.toHaveBeenCalled();
  expect(h.robinhood.list).not.toHaveBeenCalled();
});

test("a completed return is recognised on every visit to Withdraw for a later deposit", async () => {
  const h = setup({
    overview: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  });
  h.robinhood.list.mockImplementation(async (intent: EarnIntent) =>
    intent.intentId === first.intentId
      ? [
          { ...operation("withdrawn"), kind: "hoodRedeemAll" },
          { ...minimumReturnRow(), from: first.destinations[0].address },
        ]
      : [operation()],
  );
  jest.spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init) =>
      ({
        ok: true,
        json: async () => ({
          ...exitSnapshot(Date.now()),
          owner: JSON.parse(String(init?.body)).owner,
        }),
      }) as Response,
  );
  for (let visit = 0; visit < 2; visit++) {
    await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
    expect(screen.queryByText("Return to private balance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify private balance" })).toBeNull();
    expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), second.intentId, 0);
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
  }
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  expect(h.robinhood.resume).not.toHaveBeenCalled();
  expect(
    jest.mocked(getStoredEarnWithdrawalSigner)()?.executeEarnWithdrawal,
  ).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

test("a verified old exit stays complete after a fresh navigation tree starts with prices unavailable", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
  screen.unmount();
  const h = setup(options);
  jest.mocked(globalThis.fetch).mockResolvedValue({ ok: false } as Response);
  jest.mocked(globalThis.fetch).mockClear();
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
  expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), second.intentId, 0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(screen.queryByText("Return to private balance")).toBeNull();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("a changed native return revision requires a new check instead of reusing completion", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await screen.findByRole("button", { name: "Review withdrawal" });
  screen.unmount();
  const h = setup(options);
  h.robinhood.list.mockResolvedValue([
    { ...operation("withdrawn"), kind: "hoodRedeemAll" },
    { ...returnRow(), operationId: "return_0", from: first.destinations[0].address, revision: 2 },
  ]);
  jest.mocked(globalThis.fetch).mockResolvedValue({ ok: false } as Response);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified/);
  expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
});

test("a newly pending legacy payout prevents reuse of a completed private exit", async () => {
  const options = {
    overview: true,
    redeemed: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await screen.findByRole("button", { name: "Review withdrawal" });
  screen.unmount();
  const h = setup({ ...options, withdrawalPending: true });
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("button", { name: "Verify private balance" })).toBeVisible();
  expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("pending native work defeats an old completion even while inventory still says redeemed", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await screen.findByRole("button", { name: "Review withdrawal" });
  screen.unmount();
  const h = setup(options);
  h.robinhood.list.mockResolvedValue([
    { ...operation("withdrawn"), kind: "hoodRedeemAll" },
    {
      ...returnRow(),
      operationId: "return_0",
      from: first.destinations[0].address,
      status: "pending",
      blocked: true,
      creditedAtoms: undefined,
    },
  ]);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("button", { name: "Check withdrawal status" })).toBeEnabled();
  expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("explicitly checking past withdrawals restores later residual recovery and removes old completion", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  const h = setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await screen.findByRole("button", { name: "Review withdrawal" });
  jest.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
    const raw = exitSnapshot(Date.now());
    raw.owner = JSON.parse(String(init?.body)).owner;
    raw.balances.tokenAtoms = raw.residualUsdcAtoms = "700000";
    raw.publicResidualReady = false;
    return { ok: true, json: async () => raw } as Response;
  });
  await userEvent.press(screen.getByRole("button", { name: "Check past withdrawals" }));
  expect(await screen.findByRole("button", { name: "Verify private balance" })).toBeVisible();
  expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), first.intentId, 0);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  screen.unmount();
  setup(options);
  jest.mocked(globalThis.fetch).mockResolvedValue({ ok: false } as Response);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified/);
});

test("the existing final verification panel records completion for the next app visit", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  const h = setup(options);
  h.robinhood.list.mockResolvedValueOnce([
    { ...operation("withdrawn"), kind: "hoodRedeemAll" },
    {
      ...returnRow(),
      operationId: "return_0",
      from: first.destinations[0].address,
      status: "awaitingSettlement",
      creditedAtoms: undefined,
    },
  ]);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await userEvent.press(await screen.findByRole("button", { name: "Verify private balance" }));
  await screen.findByText("Private return verified for this part.");
  screen.unmount();
  setup(options);
  jest.mocked(globalThis.fetch).mockResolvedValue({ ok: false } as Response);
  jest.mocked(globalThis.fetch).mockClear();
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("leaving Withdraw during a stored observation read ignores its late match", async () => {
  const options = {
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  };
  setup(options);
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await screen.findByRole("button", { name: "Review withdrawal" });
  screen.unmount();
  const key = (await AsyncStorage.getAllKeys()).find((value) =>
    value.startsWith("gizu:completed-exit:v1:"),
  )!;
  const saved = await AsyncStorage.getItem(key);
  let finish: (() => void) | undefined;
  const originalRead = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;
  jest.spyOn(AsyncStorage, "getItem").mockImplementation(async (requested) =>
    requested === key
      ? new Promise((resolve) => {
          finish = () => resolve(saved);
        })
      : null,
  );
  try {
    const h = setup(options);
    await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(finish).toBeDefined());
    await userEvent.press(screen.getByRole("button", { name: "Back" }));
    finish!();
    expect(await screen.findByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
    expect(h.robinhood.execute).not.toHaveBeenCalled();
  } finally {
    jest.mocked(AsyncStorage.getItem).mockImplementation(originalRead);
  }
});

test.each(["unavailable", "remaining shares", "wrong owner"])(
  "a %s exit check preserves the old return for recovery",
  async (problem) => {
    const h = setup({
      redeemed: true,
      privateOnly: true,
      rows: [position(first, 0, "redeemed"), position(second)],
    });
    jest.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const raw = exitSnapshot(Date.now());
      raw.owner =
        problem === "wrong owner" ? "0x" + "f".repeat(40) : JSON.parse(String(init?.body)).owner;
      if (problem === "remaining shares") {
        raw.balances.shares = "1";
        raw.publicResidualReady = false;
      }
      return { ok: problem !== "unavailable", json: async () => raw } as Response;
    });
    if (problem === "remaining shares") {
      expect(await screen.findByRole("button", { name: "Verify private balance" })).toBeEnabled();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        problem === "unavailable" ? /could not be verified/ : /binding changed/,
      );
      expect(screen.queryByText("Return to private balance")).toBeNull();
      jest.mocked(globalThis.fetch).mockImplementation(
        async (_url, init) =>
          ({
            ok: true,
            json: async () => ({
              ...exitSnapshot(Date.now()),
              owner: JSON.parse(String(init?.body)).owner,
            }),
          }) as Response,
      );
      await userEvent.press(screen.getByRole("button", { name: "Refresh position" }));
      expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
    }
    if (problem === "remaining shares")
      expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
    expect(h.robinhood.execute).not.toHaveBeenCalled();
  },
);

test("a transferred return without authenticated private credit is not skipped", async () => {
  const h = setup({
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  });
  h.robinhood.list.mockResolvedValue([
    { ...operation("withdrawn"), kind: "hoodRedeemAll" },
    {
      ...returnRow(),
      from: first.destinations[0].address,
      status: "awaitingSettlement",
      creditedAtoms: undefined,
    },
  ]);
  expect(await screen.findByRole("button", { name: "Check private return" })).toBeEnabled();
  expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("leaving Withdraw during an exit check ignores its late completion", async () => {
  const h = setup({
    overview: true,
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(second)],
  });
  let finish!: (value: Response) => void;
  jest.mocked(globalThis.fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  finish({
    ok: true,
    json: async () => ({ ...exitSnapshot(Date.now()), owner: first.destinations[0].address }),
  } as Response);
  expect(await screen.findByRole("button", { name: "Withdraw" })).toBeEnabled();
  expect(h.select).not.toHaveBeenCalledWith(expect.anything(), second.intentId);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("withdrawal recovery opens only after Withdraw and Back returns to the invested overview", async () => {
  const h = setup({
    overview: true,
    rows: [position(first, 0, "redeemed"), position(second)],
    savedOperations: [
      { ...operation("withdrawn"), kind: "hoodRedeemAll" },
      { ...minimumReturnRow(), from: first.destinations[0].address },
    ],
  });
  await userEvent.press(await screen.findByRole("button", { name: "Withdraw" }));
  expect(await screen.findByText("Return to private balance")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Verify private balance" })).toBeEnabled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("button", { name: "Withdraw" })).toBeEnabled();
  expect(screen.queryByText("Return to private balance")).toBeNull();
});
test("vault withdrawal selects its saved profile and slot, displays one combined position and never funds", async () => {
  const h = setup();
  expect(await screen.findByText("Steakhouse USDG")).toBeVisible();
  expect(await screen.findByText("Deposited: 3 USDG")).toBeVisible();
  expect(screen.getByText("Current value: 2.99 USDC")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeEnabled();
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
  await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
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
  await screen.findByRole("button", { name: "Review withdrawal" });
  h.setRows([position(first, 0, "returned"), position(first, 1), position(second)]);
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  h.setRows([position(first, 0, "returned"), position(first, 1, "returned"), position(second)]);
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), second.intentId, 0),
  );
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  h.setRows([
    position(first, 0, "returned"),
    position(first, 1, "returned"),
    position(second, 0, "returned"),
  ]);
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  expect(
    await screen.findByText("All saved withdrawals for this vault are complete."),
  ).toBeVisible();
});
test("pending work resumes its saved step and does not repeat a withdrawal", async () => {
  const h = setup({ pending: true, rows: [position(first, 1, "pending")] });
  expect(await screen.findByText("Checking your saved transaction")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Continue saved transaction" }));
  expect(await screen.findByText("Your investment is ready to withdraw.")).toBeVisible();
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
  const returnPlan = privateReturnPlan();
  h.robinhood.plan.mockResolvedValueOnce(returnPlan);
  h.robinhood.execute.mockResolvedValueOnce({
    ...operation("withdrawn"),
    kind: "hoodRedeemAll",
    redeemedUsdgAtoms: "900000",
  });
  await userEvent.press(await screen.findByRole("button", { name: "Review withdrawal" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeVisible();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole("button", { name: "Confirm withdrawal" }));
  expect(await screen.findByRole("button", { name: "Confirm private return" })).toBeVisible();
  expect(h.robinhood.execute).toHaveBeenCalledWith(
    expect.objectContaining({ intentId: first.intentId, investmentSlot: 0 }),
    plan,
  );
  expect(screen.queryByRole("button", { name: "Review private return" })).toBeNull();
  expect(h.robinhood.plan).toHaveBeenLastCalledWith(
    expect.anything(),
    "hoodTokenReturn",
    expect.anything(),
  );
  expect(h.robinhood.execute).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Verify private balance" })).toBeNull();
  expect(screen.queryByText(/Wallet [0-9]/)).toBeNull();
  expect(h.prepare).not.toHaveBeenCalled();
});
test("inventory read failures offer a retry without selecting or funding", async () => {
  const h = setup();
  h.listPositions.mockRejectedValueOnce(new Error("Saved activity temporarily unavailable"));
  expect(await screen.findByText("Saved activity temporarily unavailable")).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  expect(screen.queryByText("No saved withdrawal activity for this vault.")).toBeNull();
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeVisible();
  expect(h.prepare).not.toHaveBeenCalled();
});
test("invalid native inventory identity fails closed before selection", async () => {
  const h = setup({ rows: [{ ...position(first), intentId: "foreign-intent" }] });
  expect(await screen.findByText("Saved vault activity identity changed.")).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.robinhood.list).not.toHaveBeenCalled();
});

test("a fresh complete exit and paid receiving withdrawal select the next saved portion automatically", async () => {
  const h = setup({ redeemed: true, rows: [position(first, 0, "redeemed"), position(first, 1)] });
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeVisible();
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test("a vault exit finishes at verified private credit without creating a public payout", async () => {
  const h = setup({
    redeemed: true,
    privateOnly: true,
    rows: [position(first, 0, "redeemed"), position(first, 1)],
  });
  expect(await screen.findByRole("button", { name: "Review withdrawal" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Review withdrawal to Monad receiving account/ }),
  ).toBeNull();
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  expect(
    jest.mocked(getStoredEarnWithdrawalSigner)()?.executeEarnWithdrawal,
  ).not.toHaveBeenCalled();
});
test.each([{ residualAtoms: "700000" }, { withdrawalPending: true }])(
  "residual assets or pending receiving withdrawal prevent advancing",
  async (option) => {
    const h = setup({
      ...option,
      redeemed: true,
      rows: [position(first, 0, "redeemed"), position(first, 1)],
    });
    await userEvent.press(await screen.findByRole("button", { name: "Verify private balance" }));
    await screen.findByText(/Private return verified|Some funds are still/);
    await userEvent.press(
      screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
    );
    await screen.findByRole("button", { name: "Verify private balance" });
    expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), first.intentId, 0);
    expect(h.selectInvestmentSlot).not.toHaveBeenCalledWith(expect.anything(), first.intentId, 1);
  },
);
test("an expired exit snapshot cannot skip a saved portion", async () => {
  const h = setup({ redeemed: true, rows: [position(first, 0, "redeemed"), position(first, 1)] });
  jest.mocked(globalThis.fetch).mockImplementation(
    async (_url, init) =>
      ({
        ok: true,
        json: async () => ({
          ...exitSnapshot(Date.now() - 65000),
          owner: JSON.parse(String(init?.body)).owner,
        }),
      }) as Response,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/expired|stale/i);
  expect(screen.queryByText("Return to private balance")).toBeNull();
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/expired|stale/i);
  expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), first.intentId, 0);
  expect(h.selectInvestmentSlot).not.toHaveBeenCalledWith(expect.anything(), first.intentId, 1);
});
test("verified completed portions stay complete during the withdrawal visit", async () => {
  const now = Date.now();
  const h = setup({
    redeemed: true,
    rows: [position(first, 0, "redeemed"), position(first, 1, "redeemed")],
  });
  expect(
    await screen.findByText("All saved withdrawals for this vault are complete."),
  ).toBeVisible();
  await waitFor(() =>
    expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
  );
  jest.spyOn(Date, "now").mockReturnValue(now + 65000);
  await userEvent.press(
    screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
  );
  expect(
    await screen.findByText("All saved withdrawals for this vault are complete."),
  ).toBeVisible();
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
    expect(
      await screen.findByText("All saved withdrawals for this vault are complete."),
    ).toBeVisible();
    await waitFor(() =>
      expect(h.selectInvestmentSlot).toHaveBeenCalledWith(expect.anything(), first.intentId, 1),
    );
    h.setRows([position(first, 0, activity), position(first, 1, "redeemed")]);
    await userEvent.press(
      screen.getByRole("button", { name: /Refresh position|Continue withdrawal/ }),
    );
    await waitFor(() =>
      expect(h.selectInvestmentSlot).toHaveBeenLastCalledWith(expect.anything(), first.intentId, 0),
    );
    expect(h.robinhood.execute).not.toHaveBeenCalled();
  },
);

function unfinishedReview(status: SponsoredOperation["status"] = "planned"): SponsoredOperation {
  return {
    ...operation(status),
    operationId: "unfinished_withdrawal",
    kind: "hoodRedeemAll",
    blocked: true,
    canResume: true,
    canCancelPreparation: status === "planned" || status === "authorizationSaved",
  };
}
function privateReturnPlan() {
  const now = Date.now();
  const raw = hoodRaw("hoodTokenReturn", now, "private_return");
  raw.owner = first.destinations[0].address;
  raw.operation.sender = first.destinations[0].address;
  if (!("route" in raw)) throw new Error("Expected private return fixture.");
  raw.route.refundOwner = first.destinations[0].address;
  return parseRobinhoodPlan(raw, first, "hoodTokenReturn", "private_return", 1, now);
}
function withdrawalPlan() {
  const now = Date.now();
  const raw = hoodRaw("hoodRedeemAll", now, "fresh_withdrawal");
  raw.owner = first.destinations[0].address;
  raw.operation.sender = first.destinations[0].address;
  return parseRobinhoodPlan(raw, first, "hoodRedeemAll", "fresh_withdrawal", 1, now);
}
test("an unfinished unsigned withdrawal offers a fresh review without competing disabled actions", async () => {
  const saved = unfinishedReview();
  const h = setup({ savedOperations: [operation(), saved] });
  h.robinhood.cancelUnsigned.mockResolvedValue({
    ...saved,
    status: "cancelled",
    blocked: false,
    canResume: false,
  });
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  expect(
    await screen.findByText(
      "Your previous review was not completed. Start a fresh review with current fees. No withdrawal transaction has been submitted.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Start a fresh review" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Start a fresh review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  expect(h.robinhood.cancelUnsigned).toHaveBeenCalledWith(
    expect.objectContaining({ investmentSlot: 0 }),
    saved,
  );
  expect(h.robinhood.plan).toHaveBeenCalledWith(
    expect.anything(),
    "hoodRedeemAll",
    expect.anything(),
  );
  expect(h.robinhood.resume).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test("a refused preparation reset stays blocked and reports blank native errors", async () => {
  const saved = unfinishedReview();
  const h = setup({ savedOperations: [operation(), saved] });
  h.robinhood.cancelUnsigned.mockRejectedValue(new Error("  "));
  await userEvent.press(await screen.findByRole("button", { name: "Start a fresh review" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not complete/i);
  expect(screen.getByRole("button", { name: "Start a fresh review" })).toBeEnabled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test("a signed withdrawal can only continue its saved transaction, never reset or prepare another", async () => {
  const saved = { ...unfinishedReview("signed"), userOperationHash: "0x" + "a".repeat(64) };
  const h = setup({ savedOperations: [operation(), saved] });
  h.robinhood.resume.mockResolvedValue({ ...saved, status: "pending", canResume: false });
  await userEvent.press(await screen.findByRole("button", { name: "Continue saved transaction" }));
  expect(
    await screen.findByText(
      "Your vault withdrawal is confirming. The private return opens after the USDG arrives.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Start a fresh review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  expect(h.robinhood.cancelUnsigned).not.toHaveBeenCalled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.resume).toHaveBeenCalledTimes(1);
});
test("an expired saved signature asks for a new signature on the first continue", async () => {
  const saved = {
    ...unfinishedReview("signed"),
    userOperationHash: "0x" + "a".repeat(64),
    signatureExpired: true,
  };
  const h = setup({ savedOperations: [operation(), saved] });
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  expect(
    await screen.findByText("The saved sponsored deadline expired. Please re-sign the transaction"),
  ).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Continue saved transaction" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  expect(h.robinhood.resume).not.toHaveBeenCalled();
  expect(h.robinhood.plan).toHaveBeenCalledWith(
    expect.anything(),
    "hoodRedeemAll",
    expect.anything(),
  );
  expect(h.robinhood.cancelUnsigned).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});
test("another saved-signature failure keeps the same transaction ready to send", async () => {
  const saved = { ...unfinishedReview("signed"), userOperationHash: "0x" + "a".repeat(64) };
  const h = setup({ savedOperations: [operation(), saved] });
  h.robinhood.resume.mockRejectedValue(new Error("The funding provider is unavailable."));
  await userEvent.press(await screen.findByRole("button", { name: "Continue saved transaction" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The funding provider is unavailable.",
  );
  await userEvent.press(screen.getByRole("button", { name: "Continue saved transaction" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The funding provider is unavailable.",
  );
  expect(h.robinhood.resume).toHaveBeenCalledTimes(2);
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.cancelUnsigned).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("a failed transaction status check explains the error and preserves the saved withdrawal", async () => {
  const saved = {
    ...unfinishedReview("pending"),
    canResume: false,
    userOperationHash: "0x" + "a".repeat(64),
  };
  const h = setup({ savedOperations: [operation(), saved] });
  await screen.findByRole("button", { name: "Check withdrawal status" });
  h.robinhood.list.mockRejectedValueOnce(
    new Error(
      "Could not check the transaction status. Your saved transaction is kept. Please try again shortly.",
    ),
  );
  await userEvent.press(screen.getByRole("button", { name: "Check withdrawal status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/Your saved transaction is kept/);
  expect(screen.getByRole("button", { name: "Check withdrawal status" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Start a fresh review" })).toBeNull();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  expect(h.robinhood.resume).not.toHaveBeenCalled();
});

test("an expired on-screen review refreshes its terms instead of opening approval", async () => {
  const now = Date.now();
  const h = setup();
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  await userEvent.press(await screen.findByRole("button", { name: "Review withdrawal" }));
  await screen.findByRole("button", { name: "Confirm withdrawal" });
  jest.spyOn(Date, "now").mockReturnValue(now + 60000);
  await userEvent.press(screen.getByRole("button", { name: "Confirm withdrawal" }));
  expect(await screen.findByRole("button", { name: "Refresh review" })).toBeEnabled();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  await userEvent.press(screen.getByRole("button", { name: "Refresh review" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  expect(h.robinhood.plan).toHaveBeenCalledTimes(2);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("failed native approval clears the old quote and exposes recovery of the saved preparation", async () => {
  const h = setup();
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  h.robinhood.execute.mockRejectedValue(new Error(""));
  await userEvent.press(await screen.findByRole("button", { name: "Review withdrawal" }));
  await screen.findByRole("button", { name: "Confirm withdrawal" });
  h.robinhood.list.mockResolvedValue([operation(), unfinishedReview()]);
  await userEvent.press(screen.getByRole("button", { name: "Confirm withdrawal" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not complete/i);
  expect(screen.getByRole("button", { name: "Start a fresh review" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Confirm withdrawal" })).toBeNull();
  expect(h.robinhood.execute).toHaveBeenCalledTimes(1);
});

test("fresh-review retries preserve a successful cancellation when planning is unavailable", async () => {
  const saved = unfinishedReview("authorizationSaved");
  saved.preparationCancellationDisclosure = "Previously approved wallet setup remains saved.";
  const h = setup({ savedOperations: [operation(), saved] });
  const cancelled = { ...saved, status: "cancelled", blocked: false, canResume: false };
  h.robinhood.cancelUnsigned.mockResolvedValue(cancelled);
  await screen.findByRole("button", { name: "Start a fresh review" });
  expect(
    screen.getByText(/Any wallet setup permission you already approved stays saved/),
  ).toBeVisible();
  await userEvent.press(screen.getByRole("button", { name: "Activity details" }));
  expect(screen.getByText("Previously approved wallet setup remains saved.")).toBeVisible();
  h.robinhood.list.mockResolvedValue([operation(), cancelled]);
  await userEvent.press(screen.getByRole("button", { name: "Start a fresh review" }));
  expect(await screen.findByText("Fresh review unavailable")).toBeVisible();
  expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeEnabled();
  h.robinhood.plan.mockResolvedValue(withdrawalPlan());
  await userEvent.press(screen.getByRole("button", { name: "Review withdrawal" }));
  expect(await screen.findByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  expect(h.robinhood.cancelUnsigned).toHaveBeenCalledTimes(1);
  expect(h.robinhood.execute).not.toHaveBeenCalled();
});

test("a completed vault receipt opens the private return instead of asking for another vault signature", async () => {
  const withdrawn = {
    ...operation("withdrawn"),
    operationId: "redeem_1",
    kind: "hoodRedeemAll" as const,
    redeemedUsdgAtoms: "900000",
    blocked: false,
  };
  const saved = {
    ...unfinishedReview("signed"),
    userOperationHash: "0x" + "a".repeat(64),
    signatureExpired: true,
  };
  const h = setup({ savedOperations: [operation(), withdrawn, saved] });
  expect(
    await screen.findByText(
      "Your funds have left the vault. Return them to your private USDC balance next.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/Please re-sign/)).toBeNull();
  expect(screen.getByRole("button", { name: "Review private return" })).toBeEnabled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
  expect(h.robinhood.resume).not.toHaveBeenCalled();
});
test("the guided withdrawal signs the return after the vault receipt and verifies private credit before completion", async () => {
  const h = setup();
  const withdrawn = {
    ...operation("withdrawn"),
    operationId: "redeem_1",
    kind: "hoodRedeemAll" as const,
    redeemedUsdgAtoms: "900000",
  };
  const returning = {
    ...returnRow(),
    from: first.destinations[0].address,
    status: "awaitingSettlement" as const,
  };
  const plan = privateReturnPlan();
  if (!plan.route) throw new Error("Expected verified return route.");
  plan.route.providerFeeBps = 45;
  h.robinhood.plan.mockResolvedValueOnce(withdrawalPlan()).mockResolvedValueOnce(plan);
  h.robinhood.execute.mockResolvedValueOnce(withdrawn).mockResolvedValueOnce(returning);
  h.robinhood.reconcileCredit.mockResolvedValue({ ...returning, status: "credited" });
  await userEvent.press(await screen.findByRole("button", { name: "Review withdrawal" }));
  await userEvent.press(await screen.findByRole("button", { name: "Confirm withdrawal" }));
  expect(await screen.findByRole("button", { name: "Confirm private return" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Review private return" })).toBeNull();
  expect(h.robinhood.execute).toHaveBeenCalledTimes(1);
  expect(h.robinhood.plan).toHaveBeenLastCalledWith(
    expect.anything(),
    "hoodTokenReturn",
    expect.anything(),
  );
  expect(await screen.findByText("0.98 USDC")).toBeVisible();
  expect(
    screen.getByText(
      "Your USDC stays private in Gizu. The quoted return service fee is 0.45%. A small balance may remain for network costs.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Review private return" })).toBeNull();
  expect(h.robinhood.execute).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByRole("button", { name: "Confirm private return" }));
  expect(await screen.findByRole("button", { name: "Check private return" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Verify private balance" })).toBeNull();
  expect(h.robinhood.execute).toHaveBeenCalledTimes(2);
  await userEvent.press(screen.getByRole("button", { name: "Check private return" }));
  expect(await screen.findByRole("button", { name: "Verify private balance" })).toBeVisible();
  expect(h.robinhood.reconcileCredit).toHaveBeenCalledWith(
    expect.objectContaining({ investmentSlot: 0 }),
    returning,
  );
  expect(h.robinhood.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({ investmentSlot: 0 }),
    plan,
  );
  expect(screen.queryByText(returning.transactionHash!)).toBeNull();
  await userEvent.press(screen.getByRole("button", { name: "Activity details" }));
  expect(screen.getByText(returning.transactionHash!)).toBeVisible();
});

test("restored minimum return exposes final verification without repeating withdrawal or return", async () => {
  const confirmed = { ...minimumReturnRow(), from: first.destinations[0].address };
  const h = setup({
    savedOperations: [
      { ...operation("withdrawn"), operationId: "redeem_1", kind: "hoodRedeemAll" },
      confirmed,
    ],
  });
  expect(await screen.findByText("At least 0.899 USDC verified")).toBeVisible();
  expect(screen.getByRole("button", { name: "Verify private balance" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Review private return" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review withdrawal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Check private return" })).toBeNull();
  expect(h.robinhood.execute).not.toHaveBeenCalled();
  expect(h.robinhood.plan).not.toHaveBeenCalled();
});
