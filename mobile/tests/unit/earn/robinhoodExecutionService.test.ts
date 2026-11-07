import { createEarnRobinhoodService } from "@/services/earn/robinhoodExecution";
import { hoodIntent, hoodRaw } from "../../support/robinhoodEarn";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { parseRobinhoodPlan } from "@/domain/earn/robinhoodExecution";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";
jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredEarnSponsoredSigner: jest.fn().mockReturnValue(null),
  getSignerCapabilities: jest.fn().mockResolvedValue({ earnSponsoredExecution: true }),
}));
const now = 1000000;
const row: SponsoredOperation = {
  operationId: "hood_1",
  revision: 1,
  walletId: hoodIntent.walletId,
  kind: "hoodDeposit",
  chainId: 4663,
  from: hoodIntent.destinations[1].address,
  amountAtoms: "937500",
  nonce: "0x2",
  blocked: false,
  canResume: false,
  status: "invested",
};
function native() {
  return {
    prepareEarnSourceQuote: jest.fn(),
    executeEarnSponsored: jest.fn().mockResolvedValue(row),
    listEarnSponsoredOperations: jest.fn().mockResolvedValue([row]),
    resumeEarnSponsoredOperation: jest.fn().mockResolvedValue(row),
    cancelEarnSponsoredOperation: jest.fn().mockResolvedValue({ ...row, status: "cancelled" }),
    readEarnSponsoredSettlement: jest.fn().mockResolvedValue({
      ...row,
      kind: "hoodTokenReturn",
      status: "credited",
      transactionHash: "0x" + "a".repeat(64),
      creditedAtoms: "980000",
    }),
    lock: jest.fn(),
  };
}
afterEach(() => jest.restoreAllMocks());
test("a rejected private-return fee review explains the return without suggesting another vault redemption", async () => {
  const b = native();
  const service = createEarnRobinhoodService(
    "https://backend.test",
    () => b,
    () => now,
  );
  jest.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ code: "EARN_RETURN_QUOTE_FEE_CHANGED" }),
  } as Response);
  await expect(
    service.plan(hoodIntent, "hoodTokenReturn", new AbortController().signal),
  ).rejects.toThrow(
    "The private return network fee changed before review. Your USDG remains in the investment wallet. Refresh the return quote; no new vault withdrawal is needed.",
  );
  expect(b.executeEarnSponsored).not.toHaveBeenCalled();
});
test("private-return planner outages preserve the already-withdrawn state in the error", async () => {
  const service = createEarnRobinhoodService("https://backend.test", native, () => now);
  jest.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 502,
    json: async () => ({ code: "EARN_ROBINHOOD_RETURN_UNAVAILABLE" }),
  } as Response);
  await expect(
    service.plan(hoodIntent, "hoodTokenReturn", new AbortController().signal),
  ).rejects.toThrow(
    "A fresh private USDC return quote could not be verified. Your withdrawn USDG remains in the investment wallet. Refresh before approving the return.",
  );
});
test("returns advertise balance settlement only when the native build explicitly supports it", async () => {
  for (const supported of [false, true]) {
    jest.mocked(getSignerCapabilities).mockResolvedValueOnce({
      contractVersion: 1,
      available: true,
      walletStorage: true,
      backup: true,
      transfers: false,
      swaps: false,
      earnDepositJourney: true,
      earnBalanceDeltaSettlement: supported,
    });
    const b = native();
    jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.settlementMode).toBe(supported ? "balance-delta-v1" : undefined);
      return {
        ok: true,
        json: async () => hoodRaw("hoodTokenReturn", now, body.operationId, body.revision),
      } as Response;
    });
    await createEarnRobinhoodService(
      "https://backend.test",
      () => b,
      () => now,
    ).plan(hoodIntent, "hoodTokenReturn", new AbortController().signal);
    expect(b.executeEarnSponsored).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  }
});
test("real HTTP planner binds one current recipient role and executes only through native sponsored boundary", async () => {
  const b = native(),
    fetcher = jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => hoodRaw("hoodDeposit", now, body.operationId, body.revision),
      } as Response;
    });
  const service = createEarnRobinhoodService(
    "https://backend.test",
    () => b,
    () => now,
  );
  const p = await service.plan(hoodIntent, "hoodDeposit", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith(
    "https://backend.test/v1/earn/robinhood/deposit-plan",
    expect.objectContaining({
      body: JSON.stringify({
        owner: hoodIntent.destinations[1].address,
        operationId: p.operationId,
        revision: 1,
      }),
    }),
  );
  expect(b.executeEarnSponsored).not.toHaveBeenCalled();
  b.executeEarnSponsored.mockResolvedValueOnce({ ...row, operationId: p.operationId });
  await service.execute(hoodIntent, p);
  expect(b.executeEarnSponsored).toHaveBeenCalledWith(
    expect.objectContaining({
      proposal: expect.objectContaining({
        kind: "hoodDeposit",
        nonce: "0x2",
        withdrawalReserveAtoms: "52000",
      }),
      userOperation: expect.objectContaining({ signature: "0x" }),
    }),
  );
});
test("journal filters source operations and settlement is explicit for return only", async () => {
  const b = native();
  b.listEarnSponsoredOperations.mockResolvedValueOnce([
    row,
    {
      ...row,
      operationId: "source_1",
      kind: "sourceFunding",
      chainId: 143,
      from: hoodIntent.sourceAddress,
    },
  ]);
  const service = createEarnRobinhoodService(
    "test",
    () => b,
    () => now,
  );
  expect(await service.list(hoodIntent)).toEqual([row]);
  await expect(service.reconcileCredit(hoodIntent, row)).rejects.toThrow();
  expect(b.readEarnSponsoredSettlement).not.toHaveBeenCalled();
  await service.reconcileCredit(hoodIntent, {
    ...row,
    kind: "hoodTokenReturn",
    status: "awaitingSettlement",
  });
  expect(b.readEarnSponsoredSettlement).toHaveBeenCalledTimes(1);
  await expect(
    service.cancelUnsigned(hoodIntent, {
      ...row,
      status: "pending",
      userOperationHash: "0x" + "a".repeat(64),
    }),
  ).rejects.toThrow();
});
test("missing native build, hostile HTTP, aborted review and duplicate authorization fail without new sends", async () => {
  const b = native(),
    service = createEarnRobinhoodService(
      "test",
      () => b,
      () => now,
    ),
    abort = new AbortController();
  abort.abort();
  await expect(service.plan(hoodIntent, "hoodDeposit", abort.signal)).rejects.toThrow();
  jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 502 } as Response);
  await expect(
    service.plan(hoodIntent, "hoodDeposit", new AbortController().signal),
  ).rejects.toThrow();
  expect(b.executeEarnSponsored).not.toHaveBeenCalled();
  await expect(createEarnRobinhoodService("test", () => null).list(hoodIntent)).rejects.toThrow(
    /native/i,
  );
});
test("duplicate authorization is rejected and closed late results require native reconciliation", async () => {
  const b = native(),
    service = createEarnRobinhoodService(
      "test",
      () => b,
      () => now,
    ),
    p = parseRobinhoodPlan(
      hoodRaw("hoodDeposit", now),
      hoodIntent,
      "hoodDeposit",
      "hood_1",
      1,
      now,
    );
  let resolve!: (value: SponsoredOperation) => void;
  b.executeEarnSponsored.mockReturnValueOnce(
    new Promise<SponsoredOperation>((r) => {
      resolve = r;
    }),
  );
  const first = service.execute(hoodIntent, p);
  await expect(service.execute(hoodIntent, p)).rejects.toThrow(/running/);
  expect(b.executeEarnSponsored).toHaveBeenCalledTimes(1);
  service.cancel();
  resolve(row);
  await expect(first).rejects.toThrow(/closed/);
  expect(b.lock).toHaveBeenCalledTimes(1);
  expect(await service.list(hoodIntent)).toEqual([row]);
});
