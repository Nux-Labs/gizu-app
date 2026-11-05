import {
  parseSourcePreview,
  sourceUsdc,
  earnPaymaster,
  earnEntryPoint,
  earnDelegation,
} from "@/domain/earn/sourceFunding";
import { AbortController as NativeAbortController } from "abort-controller";
import { createEarnSourceFundingService } from "@/services/earn/sourceFunding";
import type { EarnIntent } from "@/domain/earn/types";
import type { SponsoredOperation, SponsoredRequest } from "@/domain/earn/sourceFunding";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";

jest.mock("@/services/wallet/nativeBridge", () => ({
  getStoredEarnSponsoredSigner: jest.fn().mockReturnValue(null),
  getSignerCapabilities: jest.fn().mockResolvedValue({ earnSponsoredExecution: true }),
}));
const now = 1_000_000,
  owner = "0x" + "1".repeat(40),
  confidential = "0x" + "4".repeat(40),
  recipients = ["0x" + "5".repeat(40), "0x" + "6".repeat(40)];
const intent: EarnIntent & {
  destinations: [EarnIntent["destinations"][0], EarnIntent["destinations"][0]];
} = {
  status: "prepared",
  version: "gizu-earn-v1",
  intentId: "earn-wallet",
  walletId: "wallet",
  profileId: "ethereum-usdc",
  sourceAddress: owner,
  sourceChainId: 143,
  confidentialAddress: confidential,
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: "0x" + "3".repeat(40), chainId: 1 },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function operation(change: Partial<SponsoredOperation> = {}): SponsoredOperation {
  return {
    operationId: "fund_1",
    walletId: intent.walletId,
    revision: 1,
    kind: "sourceFunding",
    chainId: 143,
    from: owner,
    amountAtoms: "989900",
    nonce: "0x0",
    blocked: false,
    canResume: false,
    status: "sourceFunded",
    userOperationHash: "0x" + "a".repeat(64),
    transactionHash: "0x" + "b".repeat(64),
    actualTokenFeeAtoms: "90",
    ...change,
  };
}
function quote(amount: string, id: string, revision: number) {
  return {
    operationId: id,
    revision,
    quoteId: `quote-${revision}`,
    providerFeeBps: 2,
    recipient: recipients[Math.min(revision - 1, 1)],
    chainId: 143,
    token: sourceUsdc,
    amountAtoms: amount,
    confidentialAccount: confidential,
    refundOwner: owner,
    expiresAt: 1100,
    minimumCreditAtoms: (BigInt(amount) - 1n).toString(),
  };
}
function feeResponse(request: { recipient: string; amount: string; budget: string }, cap: number) {
  return {
    version: "gizu-monad-funding-v1",
    chainId: 143,
    owner,
    ...request,
    token: sourceUsdc,
    feeCap: String(cap),
    remainingBudget: (BigInt(request.budget) - BigInt(request.amount) - BigInt(cap)).toString(),
    entryPoint: earnEntryPoint,
    paymaster: earnPaymaster,
    delegation: earnDelegation,
    authorizationRequired: true,
    authorizationNonce: "0",
    referenceBlock: "100",
    referenceHash: "0x" + "a".repeat(64),
    timestampMs: now,
    expiresAtMs: now + 60000,
    paymasterDataStatus: "stub",
    executionAvailable: false,
    operation: {
      sender: owner,
      nonce: "0x0",
      callData: "0x1234",
      callGasLimit: "0x1",
      verificationGasLimit: "0x1",
      preVerificationGas: "0x1",
      paymasterVerificationGasLimit: "0x1",
      paymasterPostOpGasLimit: "0x1",
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x0",
      paymaster: earnPaymaster,
      paymasterData: "0x1234",
      factory: "0x7702",
      factoryData: "0x",
      signature: "SDK_FAKE_SIGNATURE",
      eip7702Auth: { r: "SDK_FAKE_AUTHORIZATION" },
      authorization: { address: recipients[0] },
      providerOnly: "untrusted",
    },
  };
}
function setup(caps = [100, 100]) {
  const native = {
    prepareEarnSourceQuote: jest
      .fn()
      .mockImplementation(async (_wallet, amount, id, revision) => quote(amount, id, revision)),
    executeEarnSponsored: jest.fn().mockImplementation(async (request: SponsoredRequest) =>
      operation({
        operationId: request.proposal.operationId,
        revision: request.proposal.revision,
        amountAtoms: request.proposal.amountAtoms,
      }),
    ),
    listEarnSponsoredOperations: jest.fn().mockResolvedValue([]),
    resumeEarnSponsoredOperation: jest.fn().mockResolvedValue(operation()),
    readEarnSponsoredSettlement: jest.fn().mockResolvedValue(operation()),
    cancelEarnSponsoredOperation: jest.fn().mockResolvedValue(operation({ status: "cancelled" })),
    lock: jest.fn(),
  };
  const requests: { recipient: string; amount: string; budget: string; owner: string }[] = [];
  const fetcher = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return {
      ok: true,
      json: async () => feeResponse(request, caps[Math.min(requests.length - 1, caps.length - 1)]!),
    } as Response;
  });
  const service = createEarnSourceFundingService(
    "https://backend.example/",
    () => native,
    () => now,
  );
  return { native, fetcher, service, requests };
}
const signal = () => new AbortController().signal;
afterEach(() => jest.restoreAllMocks());

test("budget probe re-estimates the actual recipient and re-quotes a reduced amount when its fee rises", async () => {
  const { service, native, fetcher, requests } = setup([100, 300, 250]);
  const plan = await service.plan(intent, "1000000", "2000000", signal());
  expect(requests).toEqual([
    { owner, recipient: confidential, amount: "1", budget: "1000000" },
    { owner, recipient: recipients[0], amount: "989900", budget: "1000000" },
    { owner, recipient: recipients[1], amount: "989700", budget: "1000000" },
  ]);
  expect(native.prepareEarnSourceQuote.mock.calls).toEqual([
    [intent.walletId, "989900", expect.stringMatching(/^source_1000000_/), 1],
    [intent.walletId, "989700", expect.stringMatching(/^source_1000000_/), 2],
  ]);
  expect(native.prepareEarnSourceQuote.mock.calls[0]![2]).toBe(
    native.prepareEarnSourceQuote.mock.calls[1]![2],
  );
  expect(plan).toMatchObject({
    quote: { amountAtoms: "989700", revision: 2, recipient: recipients[1] },
    fees: { feeCap: "250", remainingBudget: "10050" },
    budget: "1000000",
    expiresAtMs: now + 60000,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://backend.example/v1/earn/monad/funding-plan",
    expect.objectContaining({ method: "POST", headers: { "content-type": "application/json" } }),
  );
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("execution binds the final budget and strips SDK signature and authorization placeholders", async () => {
  const { service, native } = setup();
  const plan = await service.plan(intent, "1000000", "1000000", signal());
  const funded = await service.execute(intent, plan);
  expect(native.executeEarnSponsored).toHaveBeenCalledWith(
    expect.objectContaining({
      walletId: intent.walletId,
      proposal: {
        kind: "sourceFunding",
        operationId: plan.quote.operationId,
        revision: 1,
        chainId: 143,
        profileChainId: 1,
        expectedFrom: owner,
        token: sourceUsdc,
        amountAtoms: "989900",
        nonce: "0x0",
        deadline: 1100,
        maximumTokenFeeAtoms: "100",
        budgetAtoms: "1000000",
        withdrawalReserveAtoms: "10000",
        slippageBps: 0,
        recipient: recipients[0],
        quoteId: "quote-1",
        confidentialAccount: confidential,
        refundOwner: owner,
      },
    }),
  );
  const request = native.executeEarnSponsored.mock.calls[0]![0] as SponsoredRequest;
  expect(request.userOperation.signature).toBe("0x");
  expect(request.userOperation.factory).toBe("0x7702");
  expect(request.userOperation.factoryData).toBe("0x");
  for (const field of ["eip7702Auth", "authorization", "providerOnly"])
    expect(request.userOperation).not.toHaveProperty(field);
  expect(funded.status).toBe("sourceFunded");
  expect(funded.creditedAtoms).toBeUndefined();
  expect(native.readEarnSponsoredSettlement).not.toHaveBeenCalled();
});

test.each([
  { amountAtoms: "1" },
  { refundOwner: confidential },
  { confidentialAccount: owner },
  { providerFeeBps: 0 },
  { revision: 2 },
  { chainId: 10143 },
])("changed native quote %j stops before recipient fee estimation or signing", async (change) => {
  const { service, native, fetcher } = setup();
  native.prepareEarnSourceQuote.mockImplementation(async (_wallet, amount, id, revision) => ({
    ...quote(amount, id, revision),
    ...change,
  }));
  await expect(service.plan(intent, "1000000", "1000000", signal())).rejects.toThrow(
    /quote changed/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("substituted backend recipient rejects the fee plan before native quote or signing", async () => {
  const { service, native, fetcher } = setup();
  fetcher.mockImplementationOnce(
    async (_url, init) =>
      ({
        ok: true,
        json: async () => ({
          ...feeResponse(JSON.parse(String(init?.body)), 100),
          recipient: owner,
        }),
      }) as Response,
  );
  await expect(service.plan(intent, "1000000", "1000000", signal())).rejects.toThrow(
    /sponsorship binding/,
  );
  expect(native.prepareEarnSourceQuote).not.toHaveBeenCalled();
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("fees that never stabilize stop after four actual-recipient quotes without signing", async () => {
  const { service, native } = setup([100, 200, 300, 400, 500]);
  await expect(service.plan(intent, "1000000", "1000000", signal())).rejects.toThrow(
    /fees did not stabilize/,
  );
  expect(native.prepareEarnSourceQuote).toHaveBeenCalledTimes(4);
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("duplicate actions are refused; cancellation discards a late result before the next generation proceeds", async () => {
  const { service, native } = setup();
  const pending = deferred<SponsoredOperation[]>();
  native.listEarnSponsoredOperations.mockReturnValueOnce(pending.promise);
  const oldAction = service.list(intent);
  await expect(service.list(intent)).rejects.toThrow(/Another source funding action/);
  service.cancel();
  expect(native.lock).toHaveBeenCalledTimes(1);
  await expect(service.list(intent)).rejects.toThrow(/Another source funding action/);
  pending.resolve([operation()]);
  await expect(oldAction).rejects.toThrow(/Funding closed.*Reconcile saved progress/);
  native.listEarnSponsoredOperations.mockResolvedValueOnce([operation({ status: "pending" })]);
  expect(await service.list(intent)).toEqual([expect.objectContaining({ status: "pending" })]);
  expect(native.listEarnSponsoredOperations).toHaveBeenCalledTimes(2);
});

test("funded status stays separate from authenticated operation credit and malformed credit is rejected", async () => {
  const { service, native } = setup();
  const plan = await service.plan(intent, "1000000", "1000000", signal());
  const funded = await service.execute(intent, plan);
  native.readEarnSponsoredSettlement.mockResolvedValueOnce({
    ...funded,
    status: "awaitingSettlement",
  });
  expect(await service.reconcileCredit(intent, funded)).toMatchObject({
    status: "awaitingSettlement",
  });
  native.readEarnSponsoredSettlement.mockResolvedValueOnce({
    ...funded,
    status: "credited",
    creditedAtoms: "980001",
  });
  expect(await service.reconcileCredit(intent, funded)).toMatchObject({
    status: "credited",
    creditedAtoms: "980001",
  });
  expect(native.readEarnSponsoredSettlement).toHaveBeenCalledWith(
    intent.walletId,
    funded.operationId,
    funded.revision,
  );
  native.readEarnSponsoredSettlement.mockResolvedValueOnce({
    ...funded,
    status: "credited",
    creditedAtoms: "0",
  });
  await expect(service.reconcileCredit(intent, funded)).rejects.toThrow(
    /Missing authenticated operation credit/,
  );
});

test("signed or uncertain operations cannot be released through unsigned cancellation", async () => {
  const { service, native } = setup();
  await expect(service.cancelUnsigned(intent, operation({ status: "unknown" }))).rejects.toThrow(
    /saved signature must be reconciled/,
  );
  expect(native.cancelEarnSponsoredOperation).not.toHaveBeenCalled();
  const unsigned = operation({
    status: "planned",
    userOperationHash: undefined,
    transactionHash: undefined,
  });
  expect(await service.cancelUnsigned(intent, unsigned)).toMatchObject({ status: "cancelled" });
  expect(native.cancelEarnSponsoredOperation).toHaveBeenCalledWith(intent.walletId, "fund_1", 1);
});

test("capability and source budget failures never call backend or signing", async () => {
  const { service, native, fetcher } = setup();
  jest.mocked(getSignerCapabilities).mockResolvedValueOnce({
    contractVersion: 1,
    available: true,
    walletStorage: true,
    backup: true,
    transfers: true,
    swaps: false,
    earnSponsoredExecution: false,
  });
  expect(await service.available()).toBe(false);
  await expect(service.plan(intent, "1000001", "1000000", signal())).rejects.toThrow(
    /budget within/,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(service.plan(intent, "1000000", "1000000", controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(native.prepareEarnSourceQuote).not.toHaveBeenCalled();
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("cancellation during execution rejects the late result and recovers saved progress without signing again", async () => {
  const { service, native } = setup();
  const plan = await service.plan(intent, "1000000", "1000000", signal());
  const pending = deferred<SponsoredOperation>();
  native.executeEarnSponsored.mockReturnValueOnce(pending.promise);
  const executing = service.execute(intent, plan);
  await expect(service.execute(intent, plan)).rejects.toThrow(/Another source funding action/);
  service.cancel();
  expect(native.lock).toHaveBeenCalledTimes(1);
  const saved = operation({
    operationId: plan.quote.operationId,
    status: "unknown",
    blocked: true,
    canResume: true,
  });
  pending.resolve(saved);
  await expect(executing).rejects.toThrow(/Funding closed.*Reconcile saved progress/);
  native.listEarnSponsoredOperations.mockResolvedValueOnce([saved]);
  expect(await service.list(intent)).toEqual([saved]);
  expect(native.executeEarnSponsored).toHaveBeenCalledTimes(1);
  expect(native.cancelEarnSponsoredOperation).not.toHaveBeenCalled();
});

test("discarding stale delegation preparation requires native eligibility and never releases a signed spending operation", async () => {
  const { service, native } = setup();
  const preparation = operation({
    status: "authorizationSaved",
    blocked: true,
    canResume: true,
    userOperationHash: undefined,
    transactionHash: undefined,
    canCancelPreparation: true,
    preparationCancellationDisclosure:
      "Discarding does not revoke the saved delegation authorization.",
  });
  expect(await service.cancelUnsigned(intent, preparation)).toMatchObject({ status: "cancelled" });
  expect(native.cancelEarnSponsoredOperation).toHaveBeenCalledWith(intent.walletId, "fund_1", 1);
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  await expect(
    service.cancelUnsigned(intent, { ...preparation, canCancelPreparation: false }),
  ).rejects.toThrow();
  await expect(
    service.cancelUnsigned(intent, { ...preparation, userOperationHash: "0x" + "a".repeat(64) }),
  ).rejects.toThrow();
  expect(native.cancelEarnSponsoredOperation).toHaveBeenCalledTimes(1);
});

describe("React Native funding cancellation compatibility", () => {
  const originalAbortController = global.AbortController;
  beforeEach(() => {
    global.AbortController = NativeAbortController as unknown as typeof AbortController;
  });
  afterEach(() => {
    global.AbortController = originalAbortController;
  });

  test("a live funding review works with the actual React Native AbortSignal", async () => {
    const { service, native } = setup();
    const plan = await service.plan(intent, "1000000", "1000000", signal());
    expect(plan).toMatchObject({
      quote: { amountAtoms: "989900" },
      fees: { feeCap: "100", remainingBudget: "10000" },
    });
    expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  });

  test("an already cancelled native signal prevents fee requests and native preparation", async () => {
    const { service, native, fetcher } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.plan(intent, "1000000", "1000000", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(native.prepareEarnSourceQuote).not.toHaveBeenCalled();
  });

  test("cancelling during a native quote prevents the next fee request or spending", async () => {
    const { service, native, fetcher } = setup();
    const controller = new AbortController();
    native.prepareEarnSourceQuote.mockImplementation(async (_wallet, amount, id, revision) => {
      controller.abort();
      return quote(amount, id, revision);
    });
    await expect(
      service.plan(intent, "1000000", "1000000", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(native.executeEarnSponsored).not.toHaveBeenCalled();
  });
});

test("a qualified four-bps quote reaches review without signing", async () => {
  const { service, native } = setup();
  native.prepareEarnSourceQuote.mockImplementation(async (_wallet, amount, id, revision) => ({
    ...quote(amount, id, revision),
    providerFeeBps: 4,
    feePolicy: {
      version: "qualified-2026",
      route: "source",
      totalBps: 4,
      appFees: [{ recipient: "qualified.near", fee: 4 }],
      referral: "qualified",
      integratorFeeBps: 0,
      applicationFeeAtoms: "0",
    },
  }));
  const plan = await service.plan(intent, "1000000", "2000000", signal());
  expect(plan.quote.providerFeeBps).toBe(4);
  expect(native.executeEarnSponsored).not.toHaveBeenCalled();
});

test("unsigned preview tolerates permitted server clock skew without extending its lifetime", () => {
  const preview = {
    version: "gizu-source-preview-v1",
    sourceOwner: owner,
    confidentialAccount: confidential,
    amountAtoms: "989900",
    quoteAvailable: false,
    minimumCreditAtoms: null,
    providerFeeBps: null,
    appFees: [],
    referral: null,
    blockers: ["EARN_AURORA_ROUTE_UNAVAILABLE"],
    executionAvailable: false,
    quotedAtMs: now + 1000,
    expiresAtMs: now + 61000,
  };
  expect(parseSourcePreview(preview, intent, "989900", "1000000", "100", now).quoteAvailable).toBe(
    false,
  );
  expect(() =>
    parseSourcePreview(
      { ...preview, expiresAtMs: now + 62000 },
      intent,
      "989900",
      "1000000",
      "100",
      now,
    ),
  ).toThrow("Unsigned funding preview could not be verified.");
});

test("multi-account funding executes the persisted native batch once and cannot fall back to per-source signing", async () => {
  const { native, fetcher } = setup();
  const other = "0x" + "7".repeat(40);
  const leg = {
    sourceIndex: 0,
    address: owner,
    budgetAtoms: "500000",
    amountAtoms: "489900",
    feeAtoms: "100",
    reserveAtoms: "10000",
  };
  let registered: SponsoredRequest[] = [];
  const funding = {
    ...native,
    executeEarnFundingBatch: jest.fn().mockImplementation(async () =>
      registered.map((request) =>
        operation({
          operationId: request.proposal.operationId,
          revision: request.proposal.revision,
          from: request.proposal.expectedFrom,
          sourceAccountIndex: request.proposal.sourceAccountIndex,
          fundingBatchId: request.proposal.fundingBatchId,
          fundingBatchSize: request.proposal.fundingBatchSize,
          amountAtoms: request.proposal.amountAtoms,
        }),
      ),
    ),
    registerEarnFundingPlans: jest
      .fn()
      .mockImplementation(async (_wallet, requests: SponsoredRequest[]) => {
        registered = requests;
        return requests.map((request) =>
          operation({
            operationId: request.proposal.operationId,
            revision: request.proposal.revision,
            from: request.proposal.expectedFrom,
            sourceAccountIndex: request.proposal.sourceAccountIndex,
            fundingBatchId: request.proposal.fundingBatchId,
            fundingBatchSize: request.proposal.fundingBatchSize,
            amountAtoms: request.proposal.amountAtoms,
            status: "planned",
            userOperationHash: undefined,
            transactionHash: undefined,
          }),
        );
      }),
    planPublicFunding: jest.fn().mockResolvedValue({
      fundingBatchId: "batch_1",
      requestedBudgetAtoms: "1000000",
      totalAmountAtoms: "979800",
      totalFeeAtoms: "200",
      totalReserveAtoms: "20000",
      legs: [leg, { ...leg, sourceIndex: 4, address: other }],
    }),
    prepareEarnSourceQuoteForAccount: jest
      .fn()
      .mockImplementation(async (_wallet, index, amount, id, revision) => ({
        ...quote(amount, id, revision),
        refundOwner: index === 0 ? owner : other,
      })),
  };
  fetcher.mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = feeResponse(request, 100);
    return {
      ok: true,
      json: async () => ({
        ...response,
        operation: { ...response.operation, sender: request.owner },
      }),
    } as Response;
  });
  funding.executeEarnSponsored.mockImplementation(async (request: SponsoredRequest) =>
    operation({
      operationId: request.proposal.operationId,
      revision: request.proposal.revision,
      from: request.proposal.expectedFrom,
      sourceAccountIndex: request.proposal.sourceAccountIndex,
      fundingBatchId: request.proposal.fundingBatchId,
      fundingBatchSize: request.proposal.fundingBatchSize,
      amountAtoms: request.proposal.amountAtoms,
    }),
  );
  const service = createEarnSourceFundingService(
    "https://backend.example/",
    () => funding,
    () => now,
  );
  const plans = await service.planMany!(intent, "1000000", "2000000", signal());
  expect(plans.map((plan) => plan.sourceAccountIndex)).toEqual([0, 4]);
  expect(funding.registerEarnFundingPlans).toHaveBeenCalledTimes(1);
  expect(funding.registerEarnFundingPlans.mock.calls[0]![1]).toHaveLength(2);
  expect(funding.executeEarnSponsored).not.toHaveBeenCalled();
  const rows = await service.executeMany!(intent, plans);
  expect(rows).toHaveLength(2);
  expect(funding.executeEarnFundingBatch).toHaveBeenCalledTimes(1);
  expect(funding.executeEarnFundingBatch).toHaveBeenCalledWith(intent.walletId, "batch_1");
  expect(funding.executeEarnSponsored).not.toHaveBeenCalled();
  const oldBridge = { ...funding, executeEarnFundingBatch: undefined };
  const unsupported = createEarnSourceFundingService(
    "https://backend.example/",
    () => oldBridge,
    () => now,
  );
  await expect(unsupported.executeMany!(intent, plans)).rejects.toThrow(
    "updated native batch signer",
  );
  expect(funding.executeEarnSponsored).not.toHaveBeenCalled();
});
