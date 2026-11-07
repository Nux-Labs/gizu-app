import {
  parseEarnDistribution,
  distributionAmounts,
  investmentDestination,
  payoutLegs,
} from "@/domain/earn/distribution";
import { parseDepositSnapshot } from "@/domain/earn/depositJourney";
import { hoodIntent } from "../../support/robinhoodEarn";
import { createEarnWalletService } from "@/services/wallet/earnWallets";
import { parseEarnWithdrawals } from "@/domain/earn/withdrawal";
import type { EarnIntent } from "@/domain/earn/types";

import { distributionDepositSnapshot as distributed } from "../../support/depositDistribution";
const addresses = Array.from({ length: 5 }, (_, i) => `0x${String(i + 5).repeat(40)}`);

test.each([
  [],
  [10000, 1],
  [5000, 0, 5000],
  [5000.5, 4999.5],
  [1000, 1000, 1000, 1000, 1000, 5000],
])("rejects malformed distribution weights %j", (...values) => {
  expect(() => parseEarnDistribution({ version: 1, weightsBps: values })).toThrow();
});
test("a distribution plan must be explicitly versioned", () => {
  expect(() => parseEarnDistribution({ version: 2, weightsBps: [10000] })).toThrow();
  expect(
    parseEarnDistribution({ version: 1, weightsBps: [4300, 5700], secret: "private" }),
  ).toEqual({ version: 1, weightsBps: [4300, 5700] });
});
test("fragmented credit allocates the same full total without a holding reserve", () => {
  const plan = parseEarnDistribution({ version: 1, weightsBps: [4300, 5700] });
  const first = distributionAmounts(100003n, plan);
  const second = distributionAmounts(200007n, plan, 100003n);
  const total = distributionAmounts(300010n, plan);
  expect(first.map((n, i) => n + second[i]!)).toEqual(total);
  expect(total.reduce((sum, n) => sum + n, 0n)).toBe(300010n);
});
test.each([1, 2, 5])("a %i-wallet native review has only investment recipients", (count) => {
  const raw = distributed(count);
  const parsed = parseDepositSnapshot(raw, { walletId: hoodIntent.walletId });
  expect(parsed.distribution?.weightsBps).toEqual(raw.distribution.weightsBps);
  expect(parsed.destinations).toHaveLength(count);
  expect(parsed.review?.deposits).toHaveLength(count);
  expect(parsed.review?.sources[0]?.allocations).toHaveLength(count);
  expect(parsed.holdReceivedAtoms).toBe("0");
});
test("an altered slot or recipient cannot change a reviewed allocation", () => {
  const raw = distributed();
  raw.review.sources[0]!.allocations[0]!.recipient = addresses[1]!;
  expect(() => parseDepositSnapshot(raw, { walletId: hoodIntent.walletId })).toThrow();
  const changed = distributed();
  changed.destinations[0]!.slot = 1;
  expect(() => parseDepositSnapshot(changed, { walletId: hoodIntent.walletId })).toThrow();
});
test("partial investment cannot be reported as fully invested", () => {
  const raw = {
    ...distributed(),
    phase: "invested",
    completedSteps: ["funding", "credit", "payouts", "deposit"],
    creditedAtoms: "2970000",
    investReceivedAtoms: "2930000",
    depositedAtoms: "1000000",
    sharesAtoms: "1000000",
  };
  expect(() => parseDepositSnapshot(raw, { walletId: hoodIntent.walletId })).toThrow();
});
test("an investment estimate is not reduced by the larger approval fee ceiling a second time", () => {
  const raw = distributed(1);
  const allocation = raw.review.sources[0]!.allocations[0]!;
  const d = raw.review.deposits[0]!;
  d.estimatedAssetsAtoms = (BigInt(allocation.estimatedOutputAtoms) - 16000n).toString();
  d.minimumAssetsAtoms = (BigInt(allocation.minimumOutputAtoms) - 20000n).toString();
  d.minimumSharesAtoms = d.minimumAssetsAtoms;
  d.maximumFeeAtoms = "18750";
  d.withdrawalReserveAtoms = "750";
  raw.review.deposit = { ...d };
  expect(
    parseDepositSnapshot(raw, { walletId: hoodIntent.walletId }).review?.deposits?.[0]
      ?.estimatedAssetsAtoms,
  ).toBe(d.estimatedAssetsAtoms);
});
test("legacy intent selection and payout roles stay unchanged", () => {
  expect(investmentDestination(hoodIntent).address).toBe(hoodIntent.destinations[1].address);
  expect(payoutLegs(hoodIntent)).toEqual(["hold", "invest"]);
});

test("native intent decoding preserves a distribution and its selected investment slot", async () => {
  const raw = {
    ...hoodIntent,
    version: "gizu-earn-v2",
    cycleIndex: 3,
    intentId: `earn-v2:${hoodIntent.walletId}:robinhood-usdg:3`,
    distribution: { version: 1, weightsBps: [4300, 5700] },
    destinations: distributed().destinations,
    investmentSlot: 1,
  };
  const service = createEarnWalletService(() => ({
    getEarnIntent: async () => raw,
    prepareEarnIntent: async () => raw,
    lock() {},
  }));
  const result = await service.load({ walletId: hoodIntent.walletId });
  expect("distribution" in result && result.distribution).toEqual(raw.distribution);
  expect("intentId" in result && investmentDestination(result).address).toBe(addresses[1]);
});
test("withdrawal progress belongs to the selected investment slot", () => {
  const fixture = distributed();
  const intent = {
    ...hoodIntent,
    distribution: fixture.distribution,
    investmentSlot: 1,
    destinations: fixture.destinations,
  } as EarnIntent;
  const operation = {
    operationId: "withdraw_1",
    walletId: hoodIntent.walletId,
    revision: 1,
    kind: "confidentialWithdrawal",
    leg: "withdrawal",
    chainId: 143,
    recipient: "0x" + "9".repeat(40),
    amountAtoms: "1000000",
    minimumDestinationAtoms: "900000",
    receivedAtoms: "0",
    status: "planned",
    blocked: false,
    canResume: false,
    investmentSlot: 0,
  };
  expect(() => parseEarnWithdrawals([operation], intent)).toThrow();
  expect(parseEarnWithdrawals([{ ...operation, investmentSlot: 1 }], intent)).toHaveLength(1);
});

test("distributed reviews validate private funding without public gas or address fields", () => {
  const raw = distributed();
  const source = {
    ...raw.review.sources[0]!,
    kind: "private",
    accountIndex: -1,
    address: "",
    budgetAtoms: "2970000",
    amountAtoms: "2970000",
    maximumFeeAtoms: "0",
    retainedAtoms: "0",
  };
  const privateReview = {
    ...raw,
    budgetAtoms: "2970000",
    review: { ...raw.review, sourceBudgetAtoms: "2970000", sources: [source] },
  };
  expect(
    parseDepositSnapshot(privateReview, { walletId: hoodIntent.walletId }).review?.sources[0]?.kind,
  ).toBe("private");
  expect(() =>
    parseDepositSnapshot(
      {
        ...privateReview,
        review: { ...privateReview.review, sources: [{ ...source, maximumFeeAtoms: "1" }] },
      },
      { walletId: hoodIntent.walletId },
    ),
  ).toThrow();
});
