import { parsePayoutOperations, payoutRequest } from "@/domain/earn/privatePayout";
import type { EarnIntent } from "@/domain/earn/types";
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
const funding = {
  operationId: "source_1",
  walletId: "wallet",
  revision: 4,
  kind: "sourceFunding" as const,
  chainId: 143 as const,
  from: intent.sourceAddress,
  amountAtoms: "1000000",
  nonce: "0x0",
  blocked: false,
  canResume: false,
  status: "credited" as const,
  creditedAtoms: "999901",
  transactionHash: "0x" + "a".repeat(64),
};
test("payout requests use only the native funding reference and role, never aggregate balance or source/destination graph", () => {
  expect(payoutRequest(intent, funding, "hold")).toEqual({
    walletId: "wallet",
    sourceOperationId: "source_1",
    sourceRevision: 4,
    leg: "hold",
  });
  expect(() =>
    payoutRequest(intent, { ...funding, status: "awaitingSettlement" }, "invest"),
  ).toThrow();
  expect(() => payoutRequest(intent, { ...funding, walletId: "other" }, "invest")).toThrow();
  expect(() =>
    payoutRequest(intent, { ...funding, verifiedMinimumAtoms: "999901" }, "invest"),
  ).toThrow();
});
test("public payout progress binds exact native role and refuses private payloads as completion evidence", () => {
  const row = {
    operationId: "child_1",
    walletId: "wallet",
    revision: 2,
    kind: "confidentialPayout",
    leg: "invest",
    chainId: 1,
    recipient: intent.destinations[1].address,
    amountAtoms: "899911",
    minimumDestinationAtoms: "880000",
    receivedAtoms: "0",
    status: "pending",
    blocked: true,
    canResume: false,
    signedData: "SECRET",
    nonce: "SECRET",
  };
  expect(parsePayoutOperations([row], intent)[0]).not.toHaveProperty("signedData");
  for (const change of [
    { recipient: intent.destinations[0].address },
    { chainId: 4663 },
    { status: "paid" },
    { walletId: "other" },
    { verifiedMinimumAtoms: "880000" },
    { minimumReturnReceipt: {} },
    { minimumReturnEnvelope: "private" },
  ])
    expect(() => parsePayoutOperations([{ ...row, ...change }], intent)).toThrow();
  const paid = {
    ...row,
    status: "paid",
    blocked: false,
    receivedAtoms: "885000",
    destinationTransactionHash: "0x" + "a".repeat(64),
  };
  expect(parsePayoutOperations([paid], intent)[0]).toMatchObject({
    status: "paid",
    receivedAtoms: "885000",
  });
});
