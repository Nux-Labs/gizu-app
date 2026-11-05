import { z } from "zod";

export const distributionSchema = z
  .object({
    version: z.literal(1),
    weightsBps: z
      .array(z.number().int().positive().max(10000))
      .min(1)
      .max(5)
      .refine(
        (weights) => weights.reduce((sum, weight) => sum + weight, 0) === 10000,
      ),
  })
  .strict();
export type Distribution = z.output<typeof distributionSchema>;
export const payoutLegSchema = z.enum([
  "hold",
  "invest",
  "invest:0",
  "invest:1",
  "invest:2",
  "invest:3",
  "invest:4",
]);
export type PayoutLeg = z.output<typeof payoutLegSchema>;

export function validDistributionLeg(input: {
  leg: string;
  distribution?: Distribution;
}): boolean {
  return input.distribution
    ? /^invest:[0-4]$/.test(input.leg) &&
        Number(input.leg.slice(7)) < input.distribution.weightsBps.length
    : !input.leg.startsWith("invest:");
}

/** Native persists this plan and its prior-credit offset before requesting quotes. */
export function distributionAmount(
  distribution: Distribution,
  leg: string,
  offset: bigint,
  credit: bigint,
): bigint {
  const slot = Number(leg.slice(7));
  const allocation = (total: bigint) => {
    const initial = distribution.weightsBps
      .slice(0, -1)
      .map((weight) => (total * BigInt(weight)) / 10000n);
    return [
      ...initial,
      total - initial.reduce((sum, amount) => sum + amount, 0n),
    ];
  };
  const end = offset + credit;
  if (end >= 1n << 256n) throw new Error("Distribution credit overflow");
  const startAmounts = allocation(offset);
  const amounts = allocation(end).map(
    (amount, index) => amount - startAmounts[index]!,
  );
  if (amounts.some((amount) => amount <= 0n))
    throw new Error("Nonpositive distribution allocation");
  return amounts[slot]!;
}
