import { createEarnLiquidityService } from "@/services/earn/ethereumLiquidity";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";
import type { EarnIntent } from "@/domain/earn/types";
import type {
  LiquidityOperation,
  LiquidityPlan,
  FusionProposal,
} from "@/domain/earn/ethereumLiquidity";
import type { VaultPlan } from "@/domain/earn/vaultExecution";

jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredEarnLiquiditySigner: jest.fn().mockReturnValue(null),
  getSignerCapabilities: jest.fn().mockResolvedValue({ earnEthereumLiquidityExecution: true }),
}));
const now = 1000000,
  hash = "0x" + "a".repeat(64),
  replacementHash = "0x" + "b".repeat(64);
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
const owner = intent.destinations[1].address;
const vaultPlan: VaultPlan = {
  kind: "vaultDeposit",
  operationId: "deposit_1",
  revision: 1,
  owner,
  amountAtoms: "2000000",
  shareDecimals: 18,
  nonce: 0,
  deadline: 1200,
  gasLimits: [80000],
  maxFeePerGasWei: "1",
  priorityFeePerGasWei: "0",
  maximumGasCostWei: "80000",
  withdrawalReserveWei: "80000",
  liquidAtoms: "2000000",
  expiresAtMs: now + 45000,
  fusionRequired: true,
  bootstrapUsdc: "1000000",
  fusionFunding: {
    minimumEthWei: "100",
    maximumResolverOverheadWei: "22",
    resolverGasPriceWei: "10",
  },
};
function operation(change: Partial<LiquidityOperation> = {}): LiquidityOperation {
  return {
    operationId: "return_1",
    walletId: "wallet",
    revision: 2,
    kind: "returnEth",
    chainId: 1,
    from: owner,
    amountAtoms: "79000",
    status: "pending",
    blocked: true,
    canResume: false,
    transactionHash: hash,
    ...change,
  };
}
function fusion(request: { operationId: string; revision: number; inputAtoms: string }) {
  return {
    ...request,
    owner,
    confidentialAccount: intent.confidentialAddress,
    quoteId: hash,
    minimumEthWei: "100",
    grossEthWei: "150",
    deadline: 1200,
    quotedAt: 1000,
    expiresAt: 1060,
    orderHash: hash,
    extensionHash: hash,
    resolverGasUnits: "2",
    resolverGasPriceWei: "10",
    resolverGasCostWei: "20",
    resolverProfitWei: "2",
    inputValueWei: "200",
    unsignedOrder: {
      maker: owner,
      makerAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      takerAsset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      receiver: owner,
      salt: "1",
      makerTraits: "1",
      makingAmount: request.inputAtoms,
      takingAmount: "150",
      signature: "SDK_PRIVATE_SIGNATURE",
    },
    extension: "0x1234",
    executable: false,
    rawTransaction: "PRIVATE_RAW",
    signedOrder: "PRIVATE_ORDER",
    recoveryEnvelope: "PRIVATE_RECOVERY",
  };
}
function returnReply(request: { operationId: string; revision: number; returnAsset: string }) {
  const eth = request.returnAsset === "native";
  return {
    ...request,
    kind: eth ? "returnEth" : "returnUsdc",
    chainId: 1,
    profileId: "ethereum-usdc",
    owner,
    confidentialAccount: intent.confidentialAddress,
    refundOwner: owner,
    quoteId: hash,
    recipient: "0x" + "5".repeat(40),
    amountAtoms: eth ? "79000" : "100000",
    minimumCreditAtoms: "1",
    providerFeeBps: 2,
    nonce: 3,
    deadline: 1200,
    gasLimit: eth ? 21000 : 60000,
    maxFeePerGasWei: "1",
    priorityFeePerGasWei: "0",
    maximumGasCostWei: eth ? "21000" : "60000",
    withdrawalReserveWei: eth ? "0" : "21000",
    startingNativeWei: "100000",
    startingUsdc: eth ? "0" : "100000",
    startingShares: "0",
    startingWeth: "0",
    referenceBlockNumber: "100",
    referenceBlockHash: hash,
    referenceTimestampMs: now,
    quotedAtMs: now,
    expiresAtMs: now + 45000,
    readOnly: true,
    executionAvailable: false,
    planHash: hash,
    rawTransaction: "PRIVATE_RAW",
    signature: "PRIVATE_SIGNATURE",
    recoveryEnvelope: "PRIVATE_RECOVERY",
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
    prepareEarnFusionQuote: jest.fn().mockImplementation(async (request) => fusion(request)),
    executeEarnEthereumLiquidity: jest.fn().mockImplementation(async (request) =>
      operation({
        operationId: request.proposal.operationId,
        kind: request.proposal.kind,
        amountAtoms:
          request.proposal.kind === "fusionEthOrder"
            ? request.proposal.inputAtoms
            : request.proposal.amountAtoms,
      }),
    ),
    listEarnEthereumLiquidityOperations: jest.fn().mockResolvedValue([operation()]),
    resumeEarnEthereumLiquidityOperation: jest.fn().mockResolvedValue(operation({ revision: 3 })),
    readEarnEthereumLiquiditySettlement: jest
      .fn()
      .mockResolvedValue(operation({ status: "awaitingSettlement", blocked: false })),
    cancelEarnEthereumLiquidityOperation: jest
      .fn()
      .mockResolvedValue(operation({ status: "cancelled", blocked: false })),
    cancelPendingEarnEthereumLiquidityOperation: jest.fn().mockResolvedValue(
      operation({
        status: "nonceCancelled",
        blocked: false,
        canCancelPending: false,
        cancellationTransactionHash: replacementHash,
        cancellationTransactionHashes: [replacementHash],
      }),
    ),
    lock: jest.fn(),
  };
  const requests: Record<string, unknown>[] = [];
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return { ok: true, json: async () => returnReply(request) } as Response;
  });
  return {
    native,
    requests,
    fetcher,
    service: createEarnLiquidityService(
      "https://backend.example/",
      () => native,
      () => now,
    ),
  };
}
const signal = () => new AbortController().signal;
afterEach(() => jest.restoreAllMocks());

test("Fusion read-only bootstrap uses exact reviewed budget and strips provider raw/signature/envelope fields", async () => {
  const { service, native, fetcher } = setup();
  const result = await service.bootstrap(intent, vaultPlan);
  expect(native.prepareEarnFusionQuote).toHaveBeenCalledWith({
    walletId: "wallet",
    operationId: expect.stringMatching(/^earn_fusion_/),
    revision: 1,
    inputAtoms: "1000000",
    minimumEthWei: "100",
    maximumResolverOverheadWei: "22",
    resolverGasPriceWei: "10",
    fundingMode: "permit",
  });
  expect(result.proposal).toMatchObject({
    kind: "fusionEthOrder",
    expectedFrom: owner,
    inputAtoms: "1000000",
    maximumResolverOverheadWei: "22",
    fundingMode: "permit",
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.proposal).not.toHaveProperty("signature");
  expect(fetcher).not.toHaveBeenCalled();
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
});
test.each([{ fusionRequired: false }, { expiresAtMs: now }, { fusionFunding: undefined }])(
  "invalid or expired bootstrap review %j never reaches native quote/authority",
  async (change) => {
    const { service, native } = setup();
    await expect(service.bootstrap(intent, { ...vaultPlan, ...change })).rejects.toThrow(
      /fee review/,
    );
    expect(native.prepareEarnFusionQuote).not.toHaveBeenCalled();
    expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
  },
);
test("Fusion preview rejects changed native investment owner and provider-filled execution claims", async () => {
  const { service, native } = setup();
  native.prepareEarnFusionQuote.mockImplementationOnce(async (request) => ({
    ...fusion(request),
    owner: intent.destinations[0].address,
  }));
  await expect(service.bootstrap(intent, vaultPlan)).rejects.toThrow();
  native.prepareEarnFusionQuote.mockImplementationOnce(async (request) => ({
    ...fusion(request),
    executable: true,
  }));
  await expect(service.bootstrap(intent, vaultPlan)).rejects.toThrow();
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
});
test.each(["native", "usdc"] as const)(
  "%s return planning posts only exact single-investment reference and returns unsigned sanitized proposal",
  async (asset) => {
    const { service, fetcher, requests, native } = setup();
    const result = await service.returnPlan(intent, asset, signal());
    expect(fetcher).toHaveBeenCalledWith(
      "https://backend.example/v1/earn/ethereum/return-plan",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(requests[0]).toEqual({
      owner,
      confidentialAccount: intent.confidentialAddress,
      operationId: expect.stringMatching(/^earn_return_/),
      revision: 1,
      returnAsset: asset,
    });
    expect(result.proposal).toMatchObject({
      kind: asset === "native" ? "returnEth" : "returnUsdc",
      expectedFrom: owner,
      refundOwner: owner,
      quoteId: hash,
      recipient: "0x" + "5".repeat(40),
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
  },
);
test("return planning rejects changed owner/read-only flags and expired reference economics", async () => {
  const { service, fetcher } = setup();
  for (const change of [
    { owner: intent.destinations[0].address },
    { readOnly: false },
    { executionAvailable: true },
    { expiresAtMs: now },
    { referenceTimestampMs: now - 60001 },
  ]) {
    fetcher.mockImplementationOnce(
      async (_url, init) =>
        ({
          ok: true,
          json: async () => ({ ...returnReply(JSON.parse(String(init?.body))), ...change }),
        }) as Response,
    );
    await expect(service.returnPlan(intent, "native", signal())).rejects.toThrow();
  }
});
test("aborting return review discards a late hosted response even if mocked fetch ignores abort", async () => {
  const { service, fetcher, native } = setup();
  const pending = deferred<Response>();
  let request: Parameters<typeof returnReply>[0] | undefined;
  fetcher.mockImplementationOnce(async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return pending.promise;
  });
  const controller = new AbortController();
  const review = service.returnPlan(intent, "native", controller.signal);
  controller.abort();
  pending.resolve({ ok: true, json: async () => returnReply(request!) } as Response);
  await expect(review).rejects.toThrow();
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
});
test("expired execution cannot invoke native signing and fresh execution sends only the sanitized semantic proposal", async () => {
  const { service, native } = setup();
  const plan = await service.returnPlan(intent, "native", signal());
  await expect(service.execute(intent, { ...plan, expiresAtMs: now })).rejects.toThrow(/expired/);
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
  await service.execute(intent, plan);
  expect(native.executeEarnEthereumLiquidity).toHaveBeenCalledWith({
    walletId: "wallet",
    proposal: plan.proposal,
  });
});
test.each([
  { from: intent.destinations[0].address },
  { walletId: "other" },
  { status: "filled" },
  { chainId: 4663 },
])(
  "native public operation with wrong owner/status %j rejects and strips private data on valid recovery",
  async (change) => {
    const { service, native } = setup();
    native.listEarnEthereumLiquidityOperations.mockResolvedValueOnce([
      { ...operation(), ...change },
    ]);
    await expect(service.list(intent)).rejects.toThrow();
    native.listEarnEthereumLiquidityOperations.mockResolvedValueOnce([
      {
        ...operation(),
        rawTransaction: "PRIVATE_RAW",
        signedOrder: "PRIVATE_ORDER",
        permit: "PRIVATE_PERMIT",
        recoveryEnvelope: "PRIVATE_RECOVERY",
      },
    ]);
    expect(await service.list(intent)).toEqual([operation()]);
  },
);
test("same-nonce cancellation requires native journal eligibility and forwards only exact public operation revision", async () => {
  const { service, native, fetcher } = setup();
  const op = operation({ canCancelPending: true });
  const result = await service.cancelPending(intent, op);
  expect(native.cancelPendingEarnEthereumLiquidityOperation).toHaveBeenCalledWith(
    "wallet",
    "return_1",
    2,
  );
  expect(result).toMatchObject({
    status: "nonceCancelled",
    transactionHash: hash,
    cancellationTransactionHash: replacementHash,
    blocked: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
  for (const change of [
    { canCancelPending: false },
    { blocked: false },
    { transactionHash: undefined },
    { from: intent.destinations[0].address },
  ])
    await expect(service.cancelPending(intent, { ...op, ...change })).rejects.toThrow();
  expect(native.cancelPendingEarnEthereumLiquidityOperation).toHaveBeenCalledTimes(1);
});
test("explicit return credit reconciliation uses native history and rejects pending return or unauthenticated credit", async () => {
  const { service, native } = setup();
  await expect(service.reconcileCredit(intent, operation())).rejects.toThrow(/origin return/);
  await service.reconcileCredit(
    intent,
    operation({ status: "awaitingSettlement", blocked: false }),
  );
  expect(native.readEarnEthereumLiquiditySettlement).toHaveBeenCalledWith("wallet", "return_1", 2);
  native.readEarnEthereumLiquiditySettlement.mockResolvedValueOnce({
    ...operation(),
    status: "credited",
    creditedAtoms: "999",
  });
  await expect(
    service.reconcileCredit(intent, operation({ status: "awaitingSettlement", blocked: false })),
  ).rejects.toThrow();
});
test("cancel/unmount locks pending authority, blocks duplicate actions and rejects late native success", async () => {
  const { service, native } = setup();
  const pending = deferred<LiquidityOperation>();
  native.resumeEarnEthereumLiquidityOperation.mockReturnValueOnce(pending.promise);
  const active = service.resume(intent, operation());
  service.cancel();
  expect(native.lock).toHaveBeenCalledTimes(1);
  await expect(
    service.cancelPending(intent, operation({ canCancelPending: true })),
  ).rejects.toThrow(/running/);
  pending.resolve(operation({ status: "fusionFilled", blocked: false, kind: "fusionEthOrder" }));
  await expect(active).rejects.toThrow(/closed/);
  expect((await service.list(intent))[0]!.status).toBe("pending");
  expect(native.resumeEarnEthereumLiquidityOperation).toHaveBeenCalledTimes(1);
});
test("closed Fusion preview cannot be reused as execution authority", async () => {
  const { service, native } = setup();
  const pending = deferred<ReturnType<typeof fusion>>();
  native.prepareEarnFusionQuote.mockReturnValueOnce(pending.promise);
  const review = service.bootstrap(intent, vaultPlan);
  const request = native.prepareEarnFusionQuote.mock.calls[0][0];
  service.cancel();
  pending.resolve(fusion(request));
  await expect(review).rejects.toThrow(/cancelled/);
  expect(native.executeEarnEthereumLiquidity).not.toHaveBeenCalled();
});
test("availability reports native capability and missing bridge blocks execution", async () => {
  expect(
    await createEarnLiquidityService(
      "",
      () => null,
      () => now,
    ).available(),
  ).toBe(true);
  jest
    .mocked(getSignerCapabilities)
    .mockResolvedValueOnce({ earnEthereumLiquidityExecution: false } as Awaited<
      ReturnType<typeof getSignerCapabilities>
    >);
  expect(
    await createEarnLiquidityService(
      "",
      () => null,
      () => now,
    ).available(),
  ).toBe(false);
  const plan: LiquidityPlan = {
    proposal: {
      kind: "fusionEthOrder",
      operationId: "fusion_1",
      revision: 1,
      chainId: 1,
      expectedFrom: owner,
      confidentialAccount: intent.confidentialAddress,
      quoteId: hash,
      inputAtoms: "1",
      minimumEthWei: "1",
      grossEthWei: "1",
      maximumResolverOverheadWei: "1",
      deadline: 1200,
      fundingMode: "permit",
      unsignedOrder: {},
      extension: "0x01",
    } as FusionProposal,
    expiresAtMs: now + 1000,
  };
  await expect(
    createEarnLiquidityService(
      "",
      () => null,
      () => now,
    ).execute(intent, plan),
  ).rejects.toThrow(/unavailable/);
});
