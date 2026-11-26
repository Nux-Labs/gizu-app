import { createEarnPayoutService } from "@/services/earn/privatePayout";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";
import type { EarnIntent } from "@/domain/earn/types";
import type { PayoutOperation, PayoutRequest } from "@/domain/earn/privatePayout";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";

jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredEarnPayoutSigner: jest.fn().mockReturnValue(null),
  getSignerCapabilities: jest.fn().mockResolvedValue({ earnPrivatePayoutExecution: true }),
}));
const intent: EarnIntent & {
  destinations: [EarnIntent["destinations"][0], EarnIntent["destinations"][0]];
} = {
  status: "prepared",
  version: "gizu-earn-v1",
  intentId: "intent",
  walletId: "wallet",
  profileId: "ethereum-usdc",
  sourceAddress: "0x" + "1".repeat(40),
  sourceChainId: 143,
  confidentialAddress: "0x" + "4".repeat(40),
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: "0x" + "3".repeat(40), chainId: 1 },
  ],
};
const hash = "0x" + "a".repeat(64);
const source: SponsoredOperation = {
  operationId: "funding_1",
  walletId: "wallet",
  revision: 11,
  kind: "sourceFunding",
  chainId: 143,
  from: intent.sourceAddress,
  amountAtoms: "1000100",
  nonce: "0x0",
  blocked: false,
  canResume: false,
  status: "credited",
  creditedAtoms: "1000001",
  transactionHash: hash,
};
function row(change: Partial<PayoutOperation> = {}): PayoutOperation {
  return {
    operationId: "opaque_child",
    walletId: "wallet",
    revision: 2,
    kind: "confidentialPayout",
    leg: "hold",
    chainId: 1,
    recipient: intent.destinations[0].address,
    amountAtoms: "100000",
    minimumDestinationAtoms: "99900",
    receivedAtoms: "0",
    status: "planned",
    blocked: true,
    canResume: true,
    canRefreshUnsigned: true,
    ...change,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const native = {
    executeEarnPrivatePayout: jest.fn().mockImplementation(async (request: PayoutRequest) =>
      row({
        leg: request.leg,
        recipient: intent.destinations[request.leg === "hold" ? 0 : 1].address,
        amountAtoms: request.leg === "hold" ? "100000" : "900001",
      }),
    ),
    listEarnPrivatePayoutOperations: jest.fn().mockResolvedValue([row()]),
    resumeEarnPrivatePayoutOperation: jest
      .fn()
      .mockResolvedValue(row({ revision: 3, canRefreshUnsigned: true })),
    readEarnPrivatePayoutSettlement: jest.fn().mockResolvedValue(
      row({
        status: "paid",
        blocked: false,
        canResume: false,
        canRefreshUnsigned: false,
        receivedAtoms: "99999",
        destinationTransactionHash: hash,
      }),
    ),
    cancelEarnPrivatePayoutOperation: jest
      .fn()
      .mockResolvedValue(
        row({ status: "cancelled", blocked: false, canResume: false, canRefreshUnsigned: false }),
      ),
    lock: jest.fn(),
  };
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("Private payout bodies cannot pass through JavaScript fetch");
  });
  return { native, fetcher, service: createEarnPayoutService(() => native) };
}
afterEach(() => jest.restoreAllMocks());

test.each(["hold", "invest"] as const)(
  "%s executes only exact immutable funding reference and one selected leg",
  async (leg) => {
    const { service, native, fetcher } = setup();
    const result = await service.execute(intent, source, leg);
    expect(native.executeEarnPrivatePayout).toHaveBeenCalledWith({
      walletId: "wallet",
      sourceOperationId: "funding_1",
      sourceRevision: 11,
      leg,
    });
    expect(Object.keys(native.executeEarnPrivatePayout.mock.calls[0][0]).sort()).toEqual([
      "leg",
      "sourceOperationId",
      "sourceRevision",
      "walletId",
    ]);
    expect(result.leg).toBe(leg);
    expect(result.recipient).toBe(intent.destinations[leg === "hold" ? 0 : 1].address);
    expect(fetcher).not.toHaveBeenCalled();
    expect(native.readEarnPrivatePayoutSettlement).not.toHaveBeenCalled();
  },
);
test.each([
  { status: "sourceFunded" },
  { status: "awaitingSettlement" },
  { blocked: true },
  { walletId: "other" },
  { from: intent.destinations[1].address },
  { creditedAtoms: "9" },
  { transactionHash: undefined },
] as Partial<SponsoredOperation>[])(
  "unconfirmed or mismatched source %j cannot reach native payout authority",
  async (change) => {
    const { service, native } = setup();
    await expect(service.execute(intent, { ...source, ...change }, "hold")).rejects.toThrow();
    expect(native.executeEarnPrivatePayout).not.toHaveBeenCalled();
  },
);
test("public journal strips private envelope/payload/nonce and retains unsigned refresh capability", async () => {
  const { service, native } = setup();
  native.listEarnPrivatePayoutOperations.mockResolvedValue([
    {
      ...row(),
      signedData: "PRIVATE_SIGNED",
      recoveryEnvelope: "PRIVATE_RECOVERY",
      nonce: "PRIVATE_NONCE",
      privateTokenId: "PRIVATE_TOKEN",
      confidentialAccount: intent.confidentialAddress,
    },
  ]);
  const result = await service.list(intent);
  expect(result).toEqual([row()]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(native.listEarnPrivatePayoutOperations).toHaveBeenCalledWith("wallet");
  expect(native.executeEarnPrivatePayout).not.toHaveBeenCalled();
});
test.each([
  { recipient: intent.destinations[1].address },
  { chainId: 4663 },
  { walletId: "other" },
  { status: "delivered" },
  { status: "paid" },
  { status: "paid", receivedAtoms: "99999", destinationTransactionHash: hash, blocked: true },
])("wrong native binding or unsupported completion %j rejects", async (change) => {
  const { service, native } = setup();
  native.listEarnPrivatePayoutOperations.mockResolvedValue([{ ...row(), ...change }]);
  await expect(service.list(intent)).rejects.toThrow();
});
test("resume, explicit private-history reconcile and unsigned cancel forward only the opaque child revision", async () => {
  const { service, native, fetcher } = setup();
  const operation = row();
  await service.resume(intent, operation);
  await service.reconcile(intent, operation);
  await service.cancelUnsigned(intent, operation);
  expect(native.resumeEarnPrivatePayoutOperation).toHaveBeenCalledWith("wallet", "opaque_child", 2);
  expect(native.readEarnPrivatePayoutSettlement).toHaveBeenCalledWith("wallet", "opaque_child", 2);
  expect(native.cancelEarnPrivatePayoutOperation).toHaveBeenCalledWith("wallet", "opaque_child", 2);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    service.cancelUnsigned(intent, row({ status: "unknown", canRefreshUnsigned: false })),
  ).rejects.toThrow(/reconciled/);
  expect(native.cancelEarnPrivatePayoutOperation).toHaveBeenCalledTimes(1);
});
test("closing a pending native action locks authority, rejects duplicates and discards late success until saved recovery", async () => {
  const { service, native } = setup();
  const pending = deferred<PayoutOperation>();
  native.executeEarnPrivatePayout.mockReturnValueOnce(pending.promise);
  const first = service.execute(intent, source, "hold");
  service.cancel();
  expect(native.lock).toHaveBeenCalledTimes(1);
  await expect(service.execute(intent, source, "invest")).rejects.toThrow(/running/);
  pending.resolve(row({ status: "unknown", canRefreshUnsigned: false }));
  await expect(first).rejects.toThrow(/closed/);
  native.listEarnPrivatePayoutOperations.mockResolvedValue([
    row({ status: "unknown", canRefreshUnsigned: false }),
  ]);
  expect((await service.list(intent))[0]!.status).toBe("unknown");
  expect(native.executeEarnPrivatePayout).toHaveBeenCalledTimes(1);
});
test("capability gate reflects native availability and missing bridge never reaches hosted private APIs", async () => {
  expect(await createEarnPayoutService(() => null).available()).toBe(true);
  jest
    .mocked(getSignerCapabilities)
    .mockResolvedValueOnce({ earnPrivatePayoutExecution: false } as Awaited<
      ReturnType<typeof getSignerCapabilities>
    >);
  expect(await createEarnPayoutService(() => null).available()).toBe(false);
  await expect(createEarnPayoutService(() => null).execute(intent, source, "hold")).rejects.toThrow(
    /unavailable/,
  );
});

test("combined funding payout sends only the native parent reference and selected legacy leg", async () => {
  const { native, fetcher } = setup();
  const parent = {
    version: 2 as const,
    operationId: "parent_1",
    walletId: "wallet",
    revision: 5,
    cycleIndex: 0,
    profileChainId: 1 as const,
    budgetAtoms: "15000000",
    approvedExistingPrivateAtoms: "2000000",
    creditedAtoms: "14900000",
    phase: "ready" as const,
    blocked: false,
    canResume: true,
  };
  const service = createEarnPayoutService(() => native);
  const result = await service.executeFromParent!(intent, parent, "hold");
  expect(native.executeEarnPrivatePayout).toHaveBeenCalledWith({
    version: 2,
    walletId: "wallet",
    cycleIndex: 0,
    parentOperationId: "parent_1",
    leg: "hold",
  });
  expect(result.leg).toBe("hold");
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  [404, undefined, false],
  [200, { fundingContractVersion: 2, fundingChainIds: [143, 8453] }, false],
  [
    200,
    {
      fundingContractVersion: 2,
      fundingChainIds: [143, 8453],
      earnPrivateFundingVersion: 2,
      earnPrivateFundingProfileChainIds: [1],
    },
    true,
  ],
] as const)(
  "Ethereum private path requires backend admission status %s and exact profile flag",
  async (status, body, enabled) => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(2000000000000 + (status === 404 ? 0 : enabled ? 62000 : 31000));
    jest.mocked(getSignerCapabilities).mockResolvedValue({
      contractVersion: 1,
      available: true,
      walletStorage: true,
      backup: true,
      transfers: true,
      swaps: true,
      earnPrivatePayoutExecution: true,
      earnPrivateFundingVersion: 2,
      fundingContractVersion: 2,
      fundingChainIds: [143, 8453, 42161],
    });
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ status, ok: status === 200, json: async () => body } as Response);
    const parent = {
      createEarnFundingParent: jest.fn(),
      listEarnFundingParents: jest.fn(),
      executeEarnFundingParent: jest.fn(),
      resumeEarnFundingParent: jest.fn(),
      reconcileEarnFundingParent: jest.fn(),
      cancelEarnFundingParent: jest.fn(),
      lock: jest.fn(),
    };
    const service = createEarnPayoutService(undefined, () => parent);
    expect(await service.fundingRecoveryAvailable!()).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await service.fundingAvailable!()).toBe(enabled);
  },
);
