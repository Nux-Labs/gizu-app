import { parseVaultPlan, vaultProposal, parseVaultOperations } from "@/domain/earn/vaultExecution";
import { earnProfiles, type EarnIntent } from "@/domain/earn/types";
const owner = "0x" + "3".repeat(40);
export const intent: EarnIntent & {
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
    { role: "invest", address: owner, chainId: 1 },
  ],
};
const router = "0x02912516d49dE997db75B9D7858faAE59209650B";
export function depositFixture(now = 1000000) {
  return {
    operationId: "deposit_1",
    revision: 1,
    policyVersion: "ethereum-native-v1-fees8-p25-uppermedian-d10-w30-r2-liquid50000",
    profileId: "ethereum-usdc",
    chainId: 1,
    owner,
    vault: earnProfiles["ethereum-usdc"].vault,
    router,
    assets: {
      usdc: { address: earnProfiles["ethereum-usdc"].token, decimals: 6 },
      native: { symbol: "ETH", decimals: 18 },
      weth: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
      shares: { address: earnProfiles["ethereum-usdc"].vault, decimals: 18 },
    },
    referenceBlockNumber: "100",
    referenceBlockHash: "0x" + "a".repeat(64),
    referenceTimestampMs: now - 1000,
    quotedAtMs: now,
    expiresAtMs: now + 45000,
    planHash: "0x" + "b".repeat(64),
    startingBalances: {
      usdc: "10000000",
      nativeEth: "1000000000000000000",
      weth: "0",
      shares: "0",
    },
    nonce: "0",
    accountCode: "0x",
    existingSharesScope: "new-position",
    depositAmount: "9950000",
    previewShares: "1000000",
    maxSharePrice: "1000000",
    deadline: String(Math.floor(now / 1000) + 599),
    retainedLiquidUsdc: "50000",
    depositGasBudgetWei: "880000",
    withdrawalReserveWei: "1040000",
    totalBudgetWei: "1920000",
    extraUsableEthWei: "999999999998080000",
    fees: {
      baseFeeWei: "1",
      priorityFeeWei: "1",
      maximumDepositFeeWei: "4",
      withdrawalReserveFeeWei: "8",
      sampleBlocks: 8,
      percentile: 25,
      aggregation: "upper-median",
      depositHeadroomBps: 1000,
      withdrawalHeadroomBps: 3000,
      withdrawalPriceMultiplier: 2,
    },
    simulation: {
      deposit: [{ estimatedGas: "200000", actualGas: "195000", gasLimit: "220000" }],
      withdrawal: [{ estimatedGas: "100000", actualGas: "95000", gasLimit: "130000" }],
      postDepositShares: "1000000",
      withdrawalPurpose: "reserve-only-isolated-fork",
      fundingAssumption: "real-USDC-balance-with-fork-only-native-gas-override",
    },
    fusion: null,
    readOnly: true,
    simulationAvailable: true,
    executionAvailable: false,
  };
}
test("deposit proposal contains only native policy fields and keeps the withdrawal reserve", () => {
  const plan = parseVaultPlan(depositFixture(), intent, "vaultDeposit", "deposit_1", 1, 1000000);
  const p = vaultProposal(plan, intent, 1000000);
  expect(p).toMatchObject({
    kind: "vaultDeposit",
    chainId: 1,
    expectedFrom: owner,
    amountAtoms: "9950000",
    withdrawalReserveWei: "1040000",
    maximumGasCostWei: "880000",
    gasLimits: [220000],
    walletId: "wallet",
  });
  expect(p).not.toHaveProperty("data");
  expect(p).not.toHaveProperty("simulation");
  expect(p).not.toHaveProperty("review");
});
test.each([
  { owner: intent.destinations[0].address },
  { chainId: 143 },
  { router: owner },
  { revision: 2 },
  { expiresAtMs: 999999 },
  { depositAmount: "10000000" },
  { depositGasBudgetWei: "1" },
  { extraUsableEthWei: "999999999999999999" },
  { withdrawalReserveWei: "1" },
  { accountCode: "0x6000" },
  { existingSharesScope: "include-existing" },
  { startingBalances: { usdc: "10000000", nativeEth: "1", weth: "0", shares: "0" } },
  { simulationAvailable: false },
])("rejects changed or unsupported plan %j", (change) => {
  expect(() =>
    parseVaultPlan(
      { ...depositFixture(), ...change },
      intent,
      "vaultDeposit",
      "deposit_1",
      1,
      1000000,
    ),
  ).toThrow();
});
test("withdrawal consumes the reserve once and never creates a return proposal", () => {
  const row = {
    ...depositFixture(),
    kind: "vaultRedeemAll",
    token: earnProfiles["ethereum-usdc"].token,
    amountAtoms: "1000000",
    startingShares: "1000000",
    startingNativeWei: "1040000",
    startingUsdc: "50000",
    shareDecimals: 18,
    maxFeePerGasWei: "4",
    priorityFeePerGasWei: "1",
    gasLimits: ["130000"],
    maximumGasCostWei: "520000",
    retainedAfterActionWei: "0",
    returnsQuoted: false,
    minimumAssetsGuard: false,
  };
  const p = vaultProposal(
    parseVaultPlan(row, intent, "vaultRedeemAll", "deposit_1", 1, 1000000),
    intent,
    1000000,
  );
  expect(p).toMatchObject({
    kind: "vaultRedeemAll",
    amountAtoms: "1000000",
    withdrawalReserveWei: "0",
    slippageBps: 0,
  });
  expect(p).not.toHaveProperty("recipient");
});
test("native recovery results bind wallet and invest owner and omit private transaction bytes", () => {
  const row = {
    operationId: "deposit_1",
    revision: 4,
    walletId: "wallet",
    kind: "vaultDeposit",
    from: owner,
    amountAtoms: "9950000",
    actualFeeWei: "0",
    status: "pending",
    blocked: true,
    canResume: false,
    steps: [
      {
        index: 0,
        to: router,
        nonce: "0",
        status: "unknown",
        nonceConflict: false,
        transactionHash: "0x" + "a".repeat(64),
        raw: "SECRET",
      },
    ],
  };
  expect(parseVaultOperations([row], intent)[0]?.steps[0]).not.toHaveProperty("raw");
  expect(() =>
    parseVaultOperations([{ ...row, from: intent.destinations[0].address }], intent),
  ).toThrow();
  expect(() => parseVaultOperations([{ ...row, walletId: "other" }], intent)).toThrow();
  expect(() => parseVaultOperations([row, row], intent)).toThrow();
});
test("a mined withdrawal with residual shares is recoverable without claiming full exit", () => {
  const rows = parseVaultOperations(
    [
      {
        operationId: "withdraw_1",
        revision: 2,
        walletId: intent.walletId,
        kind: "vaultRedeemAll",
        from: owner,
        amountAtoms: "100",
        actualFeeWei: "50",
        status: "residualShares",
        residualShares: "1",
        blocked: false,
        canResume: false,
        steps: [
          {
            index: 0,
            to: router,
            nonce: "0",
            status: "finalized",
            nonceConflict: false,
            transactionHash: "0x" + "a".repeat(64),
          },
        ],
      },
    ],
    intent,
  );
  expect(rows[0]).toMatchObject({ status: "residualShares", residualShares: "1", blocked: false });
});
