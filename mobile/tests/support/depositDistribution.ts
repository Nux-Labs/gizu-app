import { distributionAmounts } from "@/domain/earn/distribution";
import { depositSnapshot } from "./depositJourney";
const addresses = Array.from({ length: 5 }, (_, i) => `0x${String(i + 5).repeat(40)}`);
export function distributionDepositSnapshot(count = 2) {
  const weights =
    count === 1 ? [10000] : count === 2 ? [4300, 5700] : [1800, 1900, 2000, 2100, 2200];
  const base = depositSnapshot();
  const destinations = weights.map((_, slot) => ({
    role: "invest",
    slot,
    chainId: 4663,
    address: addresses[slot]!,
  }));
  const allocations = distributionAmounts(2970000n, { version: 1, weightsBps: weights }).map(
    (input, slot) => ({
      recipient: addresses[slot]!,
      inputAtoms: input.toString(),
      estimatedOutputAtoms: (input - 10000n).toString(),
      minimumOutputAtoms: (input - 20000n).toString(),
      providerFeeBps: 2,
    }),
  );
  const deposits = allocations.map((leg, slot) => ({
    slot,
    recipient: leg.recipient,
    estimatedAssetsAtoms: (BigInt(leg.estimatedOutputAtoms) - 100000n).toString(),
    minimumAssetsAtoms: (BigInt(leg.minimumOutputAtoms) - 100000n).toString(),
    minimumSharesAtoms: (BigInt(leg.minimumOutputAtoms) - 100000n).toString(),
    shareDecimals: 6,
    maximumFeeAtoms: "50000",
    withdrawalReserveAtoms: "50000",
  }));
  const aggregate = {
    ...deposits[0]!,
    estimatedAssetsAtoms: deposits
      .reduce((n, d) => n + BigInt(d.estimatedAssetsAtoms), 0n)
      .toString(),
    minimumAssetsAtoms: deposits.reduce((n, d) => n + BigInt(d.minimumAssetsAtoms), 0n).toString(),
    minimumSharesAtoms: deposits.reduce((n, d) => n + BigInt(d.minimumSharesAtoms), 0n).toString(),
    maximumFeeAtoms: (BigInt(count) * 50000n).toString(),
    withdrawalReserveAtoms: (BigInt(count) * 50000n).toString(),
  };
  const { hold: _hold, invest: _invest, ...source } = base.review.sources[0]!;
  return {
    ...base,
    distribution: { version: 1, weightsBps: weights },
    destinations,
    review: { ...base.review, sources: [{ ...source, allocations }], deposits, deposit: aggregate },
    investments: destinations.map((d) => ({
      slot: d.slot,
      recipient: d.address,
      status: "pending",
      receivedAtoms: "0",
      depositedAtoms: "0",
      sharesAtoms: "0",
    })),
  };
}

export function pooledDistributionDepositSnapshot() {
  const raw = distributionDepositSnapshot();
  const source = raw.review.sources[0]!;
  return {
    ...raw,
    review: {
      ...raw.review,
      version: 2,
      combinedSourceId: source.operationId,
      fundedBudgetMinimumAtoms: "2970000",
      approvedExistingPrivateAtoms: "1000000",
      sources: [
        {
          ...source,
          kind: "private",
          accountIndex: -1,
          address: "",
          budgetAtoms: "2970000",
          amountAtoms: "2970000",
          minimumCreditAtoms: "2970000",
          maximumFeeAtoms: "0",
          retainedAtoms: "0",
        },
      ],
      fundingSources: [
        {
          operationId: "public_monad",
          sourceChainId: 143,
          token: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        },
        {
          operationId: "public_base",
          sourceChainId: 8453,
          token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
      ].map((row) => ({
        ...row,
        accountIndex: 1,
        address: source.address,
        budgetAtoms: "1000000",
        amountAtoms: "985000",
        minimumCreditAtoms: "985000",
        maximumFeeAtoms: "5000",
        retainedAtoms: "10000",
      })),
    },
  };
}
