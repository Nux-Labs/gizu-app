import type { EarnDestination, EarnIntent } from "./types";

export type EarnDistribution = { version: 1; weightsBps: number[] };
export type DistributionPayoutLeg = `invest:${0 | 1 | 2 | 3 | 4}`;

export function parseEarnDistribution(value: unknown): EarnDistribution {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid investment distribution.");
  const row = value as Record<string, unknown>;
  const weights = row.weightsBps;
  if (
    row.version !== 1 ||
    !Array.isArray(weights) ||
    weights.length < 1 ||
    weights.length > 5 ||
    weights.some((n) => typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > 10000) ||
    weights.reduce((sum: number, n: number) => sum + n, 0) !== 10000
  )
    throw new Error("Invalid investment distribution.");
  return { version: 1, weightsBps: [...weights] as number[] };
}

/** Saved weights validate native results; this never selects or rerolls a plan. */
export function distributionAmounts(credit: bigint, plan: EarnDistribution, offset = 0n): bigint[] {
  const checked = parseEarnDistribution(plan);
  if (credit < 0n || offset < 0n || offset + credit >= 1n << 256n)
    throw new Error("Invalid distribution credit.");
  function cumulative(total: bigint) {
    let used = 0n;
    return checked.weightsBps.map((weight, i) => {
      const amount =
        i === checked.weightsBps.length - 1 ? total - used : (total * BigInt(weight)) / 10000n;
      used += amount;
      return amount;
    });
  }
  const before = cumulative(offset);
  return cumulative(offset + credit).map((amount, i) => {
    const delta = amount - before[i]!;
    if (delta < 0n) throw new Error("Distribution credit cannot fund every wallet.");
    return delta;
  });
}

export function investmentDestination(intent: EarnIntent): EarnDestination {
  const slot = intent.distribution ? (intent.investmentSlot ?? 0) : 1;
  const destination = intent.destinations[slot];
  if (
    !destination ||
    destination.role !== "invest" ||
    (intent.distribution &&
      (destination.slot !== slot || slot >= intent.distribution.weightsBps.length))
  )
    throw new Error("Select a saved investment wallet before continuing.");
  return destination;
}

export function payoutLegs(
  intent: Pick<EarnIntent, "distribution">,
): ("hold" | "invest" | DistributionPayoutLeg)[] {
  return intent.distribution
    ? parseEarnDistribution(intent.distribution).weightsBps.map(
        (_, i) => `invest:${i}` as DistributionPayoutLeg,
      )
    : ["hold", "invest"];
}

export function payoutDestination(intent: EarnIntent, leg: string): EarnDestination {
  if (!intent.distribution) {
    if (leg !== "hold" && leg !== "invest") throw new Error("Invalid legacy payout role.");
    const destination = intent.destinations[leg === "hold" ? 0 : 1];
    if (!destination) throw new Error("Missing payout destination.");
    return destination;
  }
  if (!/^invest:[0-4]$/.test(leg)) throw new Error("Invalid investment payout slot.");
  const slot = Number(leg.slice(7));
  const destination = intent.destinations[slot];
  if (
    !destination ||
    destination.slot !== slot ||
    destination.role !== "invest" ||
    slot >= intent.distribution.weightsBps.length
  )
    throw new Error("Investment payout slot changed.");
  return destination;
}

export function investmentSlotField(intent: EarnIntent): { investmentSlot?: number } {
  return intent.distribution ? { investmentSlot: investmentDestination(intent).slot } : {};
}

export function assertInvestmentSlot(row: Record<string, unknown>, intent: EarnIntent): void {
  const expected = intent.distribution ? investmentDestination(intent).slot : undefined;
  if (row.investmentSlot !== expected)
    throw new Error("Saved operation belongs to a different investment wallet.");
}
