import {
  parsePublicFundingPlan,
  parseSourceQuote,
  parseSourceFeePlan,
  sourceFundingProposal,
  parseSponsoredOperations,
} from "@/domain/earn/sourceFunding";
import type { EarnIntent } from "@/domain/earn/types";
const owner = "0x" + "1".repeat(40),
  recipient = "0x" + "5".repeat(40),
  c = "0x" + "4".repeat(40),
  now = 1000000;
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
  confidentialAddress: c,
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: "0x" + "3".repeat(40), chainId: 1 },
  ],
};
const token = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  paymaster = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
function quote() {
  return {
    operationId: "fund_1",
    revision: 1,
    quoteId: "quote-1",
    providerFeeBps: 2 as const,
    recipient,
    chainId: 143,
    token,
    amountAtoms: "989900",
    confidentialAccount: c,
    refundOwner: owner,
    expiresAt: 1100,
    minimumCreditAtoms: "980000",
  };
}
function fee() {
  return {
    version: "gizu-monad-funding-v1",
    chainId: 143,
    owner,
    recipient,
    token,
    amount: "989900",
    budget: "1000000",
    feeCap: "100",
    remainingBudget: "10000",
    entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    paymaster,
    delegation: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
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
      paymaster,
      paymasterData: "0x1234",
      factory: "0x7702",
      factoryData: "0x",
      signature: "DUMMY",
      eip7702Auth: { r: "DUMMY" },
    },
  };
}
test("source funding binds actual quote and budget while removing SDK authorization placeholders", () => {
  const q = parseSourceQuote(quote(), intent, "fund_1", 1, "989900", now),
    p = parseSourceFeePlan(fee(), intent, recipient, "989900", "1000000", now);
  const request = sourceFundingProposal(intent, q, p, "1000000", now);
  expect(request.proposal).toMatchObject({
    kind: "sourceFunding",
    chainId: 143,
    expectedFrom: owner,
    amountAtoms: "989900",
    budgetAtoms: "1000000",
    maximumTokenFeeAtoms: "100",
    withdrawalReserveAtoms: "10000",
    confidentialAccount: c,
    refundOwner: owner,
    recipient,
  });
  expect(request.userOperation.signature).toBe("0x");
  expect(request.userOperation).not.toHaveProperty("eip7702Auth");
});
test.each([
  { refundOwner: c },
  { recipient: owner },
  { chainId: 10143 },
  { confidentialAccount: owner },
  { amountAtoms: "1" },
  { expiresAt: 999 },
])("rejects changed native quote %j", (change) =>
  expect(() =>
    parseSourceQuote({ ...quote(), ...change }, intent, "fund_1", 1, "989900", now),
  ).toThrow(),
);
test.each([
  { owner: recipient },
  { feeCap: "10101" },
  { remainingBudget: "1" },
  { token: recipient },
  { expiresAtMs: now },
  { paymaster: recipient },
  { referenceHash: "0x1" },
])("rejects changed source economics %j", (change) =>
  expect(() =>
    parseSourceFeePlan({ ...fee(), ...change }, intent, recipient, "989900", "1000000", now),
  ).toThrow(),
);
test("source transaction finality and actual private credit remain separate states", () => {
  const row = {
    operationId: "fund_1",
    walletId: "wallet",
    revision: 3,
    kind: "sourceFunding",
    chainId: 143,
    from: owner,
    amountAtoms: "989900",
    nonce: "0x0",
    blocked: false,
    canResume: false,
    status: "awaitingSettlement",
    userOperationHash: "0x" + "a".repeat(64),
    transactionHash: "0x" + "b".repeat(64),
    actualTokenFeeAtoms: "99",
    creditedAtoms: "0",
  };
  expect(parseSponsoredOperations([row], intent)[0]?.status).toBe("awaitingSettlement");
  expect(() =>
    parseSponsoredOperations([{ ...row, status: "credited", creditedAtoms: "0" }], intent),
  ).toThrow();
  expect(() =>
    parseSponsoredOperations([{ ...row, from: intent.destinations[1].address }], intent),
  ).toThrow();
});

test("native account selection retains separate gas and reserve budgets and rejects duplicate accounts", () => {
  const leg = {
    sourceIndex: 0,
    address: owner,
    budgetAtoms: "500000",
    amountAtoms: "489900",
    feeAtoms: "100",
    reserveAtoms: "10000",
  };
  const selection = {
    fundingBatchId: "batch_1",
    requestedBudgetAtoms: "1000000",
    totalAmountAtoms: "979800",
    totalFeeAtoms: "200",
    totalReserveAtoms: "20000",
    legs: [leg, { ...leg, sourceIndex: 4, address: recipient }],
  };
  expect(parsePublicFundingPlan(selection, "1000000").legs).toHaveLength(2);
  expect(() => parsePublicFundingPlan({ ...selection, legs: [leg, leg] }, "1000000")).toThrow();
  expect(() => parsePublicFundingPlan({ ...selection, totalFeeAtoms: "100" }, "1000000")).toThrow();
  expect(() => parsePublicFundingPlan(selection, "999999")).toThrow();
});
