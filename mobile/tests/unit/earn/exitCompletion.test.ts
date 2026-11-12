import { parseExitSnapshot, assertReturnCredits } from "@/domain/earn/exitCompletion";
import { hoodIntent } from "../../support/robinhoodEarn";
import { exitSnapshot, returnRow } from "../../support/exitCompletion";
const now = 1000000;
test("investment-only fresh snapshot calculates dust including explicit WETH, without trusting completion flags", () => {
  expect(parseExitSnapshot(exitSnapshot(now), hoodIntent, now).residualUsdcAtoms).toBe("100000");
  for (const patch of [
    { owner: hoodIntent.destinations[0].address },
    { wrappedToken: hoodIntent.destinations[1].address },
    { completionAttested: true },
    { prices: { ...exitSnapshot(now).prices, observedAtMs: now - 300001 } },
    {
      balances: { ...exitSnapshot(now).balances, wrappedWei: "1" },
      prices: { ...exitSnapshot(now).prices, ethUsd18: null },
    },
  ])
    expect(() => parseExitSnapshot({ ...exitSnapshot(now), ...patch }, hoodIntent, now)).toThrow();
  const dust = exitSnapshot(now);
  dust.balances.tokenAtoms = "500000";
  dust.residualUsdcAtoms = "500000";
  dust.publicResidualReady = false;
  expect(parseExitSnapshot(dust, hoodIntent, now).publicResidualReady).toBe(false);
});
test("all saved return legs need refreshed operation-specific native credit and canonical receipts", () => {
  expect(assertReturnCredits([returnRow()], hoodIntent)).toEqual(["return_1"]);
  expect(
    assertReturnCredits(
      [
        {
          ...returnRow(),
          operationId: "redeem_expired",
          kind: "hoodRedeemAll",
          status: "expired",
          transactionHash: undefined,
          creditedAtoms: undefined,
        },
        returnRow(),
      ],
      hoodIntent,
    ),
  ).toEqual(["return_1"]);
  for (const rows of [
    [],
    [{ ...returnRow(), status: "awaitingSettlement" as const }],
    [{ ...returnRow(), transactionHash: undefined }],
    [{ ...returnRow(), transactionHash: "0x" + "0".repeat(64) }],
    [{ ...returnRow(), creditedAtoms: "0" }],
    [
      returnRow(),
      { ...returnRow(), operationId: "unfinished", status: "pending" as const, blocked: true },
    ],
    [{ ...returnRow(), from: hoodIntent.destinations[0].address }],
  ])
    expect(() => assertReturnCredits(rows, hoodIntent)).toThrow();
});

test("wrapped dust is rounded up separately and current USDC price is never assumed to equal USDG", () => {
  const value = exitSnapshot(now);
  value.balances.tokenAtoms = "499999";
  value.balances.wrappedWei = "1";
  value.prices.ethUsd18 = "3000000000000000000000";
  value.prices.ethPriceUpdatedAt = new Date(now).toISOString();
  value.residualUsdcAtoms = "500000";
  value.publicResidualReady = false;
  expect(parseExitSnapshot(value, hoodIntent, now).publicResidualReady).toBe(false);
  const depeg = exitSnapshot(now);
  depeg.prices.usdcUsd18 = "500000000000000000";
  depeg.residualUsdcAtoms = "200000";
  expect(parseExitSnapshot(depeg, hoodIntent, now).residualUsdcAtoms).toBe("200000");
  for (const price of ["0", "-1", "1.1", "NaN"]) {
    expect(() =>
      parseExitSnapshot(
        { ...depeg, prices: { ...depeg.prices, usdcUsd18: price } },
        hoodIntent,
        now,
      ),
    ).toThrow();
  }
});

test("exit alone permits actual67second valuation timestamps while chain remains60second bounded", () => {
  const value = exitSnapshot(now);
  value.prices.observedAtMs = now - 67000;
  value.prices.tokenPriceUpdatedAt = new Date(now - 67000).toISOString();
  value.prices.usdcPriceUpdatedAt = new Date(now - 67000).toISOString();
  expect(parseExitSnapshot(value, hoodIntent, now).publicResidualReady).toBe(true);
  for (const patch of [
    { priceMaxAgeMs: 60000 },
    { reference: { ...value.reference, blockTimestampMs: now - 60001 } },
    {
      prices: {
        ...value.prices,
        observedAtMs: now - 300001,
        tokenPriceUpdatedAt: new Date(now - 300001).toISOString(),
        usdcPriceUpdatedAt: new Date(now - 300001).toISOString(),
      },
    },
    { snapshotHash: "0x" + "0".repeat(64) },
    { reference: { ...value.reference, blockNumber: "0" } },
    { reference: { ...value.reference, blockHash: "0x" + "0".repeat(64) } },
  ])
    expect(() => parseExitSnapshot({ ...value, ...patch }, hoodIntent, now)).toThrow();
  const nearExpiry = exitSnapshot(now);
  nearExpiry.prices.observedAtMs = now - 290000;
  nearExpiry.prices.tokenPriceUpdatedAt = new Date(now - 290000).toISOString();
  nearExpiry.prices.usdcPriceUpdatedAt = new Date(now - 290000).toISOString();
  nearExpiry.expiresAtMs = now + 10000;
  expect(parseExitSnapshot(nearExpiry, hoodIntent, now).expiresAtMs).toBe(now + 10000);
  expect(() =>
    parseExitSnapshot({ ...nearExpiry, expiresAtMs: now + 10001 }, hoodIntent, now),
  ).toThrow();
});
