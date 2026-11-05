import {
  parseFusionQuote,
  parseLiquidityOperations,
  parseEthereumReturnPlan,
} from "@/domain/earn/ethereumLiquidity";
import type { EarnIntent } from "@/domain/earn/types";
const intent: EarnIntent & {
  destinations: [EarnIntent["destinations"][0], EarnIntent["destinations"][0]];
} = {
  status: "prepared",
  version: "gizu-earn-v1",
  intentId: "earn-v1:test",
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
const h = "0x" + "a".repeat(64),
  now = 1000000;
const q = {
  operationId: "fusion_1",
  revision: 1,
  quoteId: h,
  owner: intent.destinations[1].address,
  confidentialAccount: intent.confidentialAddress,
  inputAtoms: "1000000",
  minimumEthWei: "100",
  grossEthWei: "150",
  deadline: 1200,
  quotedAt: 1000,
  expiresAt: 1060,
  orderHash: h,
  extensionHash: h,
  resolverGasUnits: "2",
  resolverGasPriceWei: "10",
  resolverGasCostWei: "20",
  resolverProfitWei: "2",
  inputValueWei: "200",
  unsignedOrder: {
    maker: intent.destinations[1].address,
    makerAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    takerAsset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    receiver: intent.destinations[1].address,
    salt: "1",
    makerTraits: "1",
    makingAmount: "1000000",
    takingAmount: "150",
  },
  extension: "0x1234",
  executable: false,
};
test("Fusion review bounds exact input and counts embedded resolver overhead once", () => {
  expect(parseFusionQuote(q, intent, "fusion_1", 1, "1000000", "100", "22", now)).toMatchObject({
    minimumEthWei: "100",
    maximumResolverOverheadWei: "22",
    fundingMode: "permit",
  });
  for (const change of [
    { owner: intent.sourceAddress },
    { inputAtoms: "1000001" },
    { resolverGasCostWei: "19" },
    { resolverProfitWei: "1" },
    { expiresAt: 1000 },
    { minimumEthWei: "99" },
  ])
    expect(() =>
      parseFusionQuote({ ...q, ...change }, intent, "fusion_1", 1, "1000000", "100", "22", now),
    ).toThrow();
});
test("liquidity recovery strips saved signatures and does not call a provider-filled status final", () => {
  const row = {
    operationId: "fusion_1",
    walletId: intent.walletId,
    revision: 2,
    chainId: 1,
    kind: "fusionEthOrder",
    from: intent.destinations[1].address,
    amountAtoms: "1000000",
    status: "pending",
    blocked: true,
    canResume: false,
    orderHash: h,
    signature: "SECRET",
    signedOrder: "SECRET",
  };
  expect(parseLiquidityOperations([row], intent)[0]).not.toHaveProperty("signature");
  expect(() => parseLiquidityOperations([{ ...row, status: "filled" }], intent)).toThrow();
  expect(() =>
    parseLiquidityOperations([{ ...row, from: intent.destinations[0].address }], intent),
  ).toThrow();
});
test("ETH return fully sweeps fixed-price gas and refuses USDC remaining or changed confidential recipient", () => {
  const p = {
    kind: "returnEth",
    operationId: "return_1",
    revision: 1,
    chainId: 1,
    profileId: "ethereum-usdc",
    owner: intent.destinations[1].address,
    confidentialAccount: intent.confidentialAddress,
    refundOwner: intent.destinations[1].address,
    quoteId: h,
    recipient: "0x" + "5".repeat(40),
    amountAtoms: "79000",
    minimumCreditAtoms: "1",
    providerFeeBps: 2,
    nonce: 1,
    deadline: 1200,
    gasLimit: 21000,
    maxFeePerGasWei: "1",
    priorityFeePerGasWei: "0",
    maximumGasCostWei: "21000",
    withdrawalReserveWei: "0",
    startingNativeWei: "100000",
    startingUsdc: "0",
    startingShares: "0",
    startingWeth: "0",
    referenceBlockNumber: "1",
    referenceBlockHash: h,
    referenceTimestampMs: now,
    quotedAtMs: now,
    expiresAtMs: now + 45000,
    readOnly: true,
    executionAvailable: false,
    planHash: h,
  };
  expect(parseEthereumReturnPlan(p, intent, "return_1", 1, now).proposal).toMatchObject({
    kind: "returnEth",
    amountAtoms: "79000",
    withdrawalReserveWei: "0",
  });
  for (const change of [
    { amountAtoms: "78999" },
    { startingUsdc: "1" },
    { confidentialAccount: intent.sourceAddress },
    { priorityFeePerGasWei: "1" },
    { startingShares: "1" },
  ])
    expect(() =>
      parseEthereumReturnPlan({ ...p, ...change }, intent, "return_1", 1, now),
    ).toThrow();
});

test("pending transaction cancellation retains original hash and finalized winner", () => {
  const original = "0x" + "b".repeat(64),
    replacement = "0x" + "c".repeat(64);
  const row = {
    operationId: "return_1",
    walletId: intent.walletId,
    revision: 4,
    chainId: 1,
    kind: "returnEth",
    from: intent.destinations[1].address,
    amountAtoms: "79000",
    status: "cancellationPending",
    blocked: true,
    canResume: false,
    canCancelPending: true,
    transactionHash: original,
    cancellationTransactionHash: replacement,
    cancellationTransactionHashes: [replacement],
    rawTransaction: "SECRET",
  };
  expect(parseLiquidityOperations([row], intent)[0]).toMatchObject({
    status: "cancellationPending",
    blocked: true,
    transactionHash: original,
    canCancelPending: true,
    cancellationTransactionHashes: [replacement],
  });
  expect(parseLiquidityOperations([row], intent)[0]).not.toHaveProperty("rawTransaction");
  expect(() =>
    parseLiquidityOperations([{ ...row, cancellationTransactionHashes: ["bad"] }], intent),
  ).toThrow();
  expect(
    parseLiquidityOperations(
      [{ ...row, status: "nonceCancelled", blocked: false, canCancelPending: false }],
      intent,
    )[0]!.status,
  ).toBe("nonceCancelled");
});
