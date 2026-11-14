import { parseRobinhoodPlan, robinhoodProposal } from "@/domain/earn/robinhoodExecution";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
const now = 1000000;
test("requested shares and source-bounded returns preserve the withdrawal portion bindings", () => {
  const raw = hoodRaw("hoodRedeemAll", now);
  const plan = parseRobinhoodPlan(
    {
      ...raw,
      amountAtoms: "400000000000000000",
      remainingShares: "400000000000000000",
      previewRedeemedUsdg: "400000",
      requestedWithdrawalAtoms: "400000",
      withdrawalRequestId: "withdraw_1",
    },
    hoodIntent,
    "hoodRedeemAll",
    "hood_1",
    1,
    now,
  );
  expect(robinhoodProposal(plan, hoodIntent, now).proposal).toMatchObject({
    amountAtoms: "400000000000000000",
    requestedWithdrawalAtoms: "400000",
    withdrawalRequestId: "withdraw_1",
  });
  const ret = hoodRaw("hoodTokenReturn", now) as any;
  ret.startingBalances.shares = "1000000000000000000";
  ret.withdrawalOperationId = "redeem_1";
  ret.returnBudgetAtoms = "1000000";
  expect(
    robinhoodProposal(
      parseRobinhoodPlan(ret, hoodIntent, "hoodTokenReturn", "hood_1", 1, now),
      hoodIntent,
      now,
    ).proposal,
  ).toMatchObject({ withdrawalOperationId: "redeem_1", returnBudgetAtoms: "1000000" });
});
test("new returns from historical investments target shared private cash", () => {
  const shared = "0x" + "9".repeat(40);
  const intent = { ...hoodIntent, returnConfidentialAddress: shared };
  const raw = hoodRaw("hoodTokenReturn", now);
  const route = (raw as { route: Record<string, unknown> }).route;
  const plan = parseRobinhoodPlan(
    { ...raw, route: { ...route, confidentialAccount: shared } },
    intent,
    "hoodTokenReturn",
    "hood_1",
    1,
    now,
  );
  expect(robinhoodProposal(plan, intent, now).proposal.confidentialAccount).toBe(shared);
  expect(() => parseRobinhoodPlan(raw, intent, "hoodTokenReturn", "hood_1", 1, now)).toThrow();
});
test("Hood deposit conserves actual USDG and forwards EntryPoint nonce with no signing placeholders", () => {
  const plan = parseRobinhoodPlan(
    hoodRaw("hoodDeposit", now),
    hoodIntent,
    "hoodDeposit",
    "hood_1",
    1,
    now,
  );
  const request = robinhoodProposal(plan, hoodIntent, now);
  expect(request.proposal).toMatchObject({
    kind: "hoodDeposit",
    nonce: "0x2",
    maximumTokenFeeAtoms: "10500",
    withdrawalReserveAtoms: "52000",
    budgetAtoms: "1000000",
    slippageBps: 10,
  });
  expect(request.userOperation.signature).toBe("0x");
  expect(request.userOperation.eip7702Auth).toBeUndefined();
  expect(() => robinhoodProposal(plan, hoodIntent, now + 45001)).toThrow(/expired|Refresh/);
});
test("withdrawal consumes only the current fee reserve and return uses immutable qualified provider route", () => {
  for (const kind of ["hoodRedeemAll", "hoodTokenReturn"] as const) {
    const plan = parseRobinhoodPlan(hoodRaw(kind, now), hoodIntent, kind, "hood_1", 1, now);
    const p = robinhoodProposal(plan, hoodIntent, now).proposal;
    expect(p.withdrawalReserveAtoms).toBe("0");
    expect(p.slippageBps).toBe(0);
    expect(p.recipient).toBe(kind === "hoodTokenReturn" ? "0x" + "5".repeat(40) : undefined);
  }
});
test("final sponsorship may consume the approved headroom without reserving it twice", () => {
  expect(
    parseRobinhoodPlan(
      { ...hoodRaw("hoodDeposit", now), depositQuoteCap: "10400" },
      hoodIntent,
      "hoodDeposit",
      "hood_1",
      1,
      now,
    ).maximumTokenFeeAtoms,
  ).toBe("10500");
});
test("changed assets, budget, sponsorship, residual valuation and stale references reject", () => {
  for (const patch of [
    { owner: hoodIntent.sourceAddress },
    { token: hoodIntent.sourceAddress },
    { withdrawalReserve: "51999" },
    { depositAmount: "937501" },
    { expiresAtMs: now },
    { startingBalances: { usdg: "1000000", shares: "0", nativeEth: "1", wrappedNative: "0" } },
  ])
    expect(() =>
      parseRobinhoodPlan(
        { ...hoodRaw("hoodDeposit", now), ...patch },
        hoodIntent,
        "hoodDeposit",
        "hood_1",
        1,
        now,
      ),
    ).toThrow();
  for (const patch of [
    { maximumResidualUsdcAtoms: "500000" },
    { price: { tokenPriceMicroUsdc: "1000000", observedAtMs: now - 300001, maximumAgeMs: 300000 } },
    {
      route: {
        ...("route" in hoodRaw("hoodTokenReturn", now)
          ? (hoodRaw("hoodTokenReturn", now) as { route: Record<string, unknown> }).route
          : {}),
        providerFeeBps: 4,
      },
    },
  ])
    expect(() =>
      parseRobinhoodPlan(
        { ...hoodRaw("hoodTokenReturn", now), ...patch },
        hoodIntent,
        "hoodTokenReturn",
        "hood_1",
        1,
        now,
      ),
    ).toThrow();
});
