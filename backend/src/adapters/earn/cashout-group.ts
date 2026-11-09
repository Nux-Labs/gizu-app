import { createHash } from "node:crypto";
import { z } from "zod";
const amount = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((v) => !/^0x0{40}$/i.test(v))
  .transform((v) => v.toLowerCase());
const child = z
  .object({
    source: z.number().int().min(0).max(31),
    slot: z.number().int().min(0).max(4),
    amountAtoms: amount,
  })
  .strict();
/** Canonical original native plan, never a mutable quote or a private transaction attribution. */
export const cashoutGroupSchema = z
  .object({
    plan: z
      .object({
        proposal: z
          .object({
            operationId: z.string().regex(/^[-a-zA-Z0-9_]{1,96}$/),
            amountAtoms: amount,
            sources: z
              .array(
                z
                  .object({
                    kind: z.enum(["swap", "earn"]),
                    profileChainId: z.number().int(),
                    cycleIndex: z.number().int().min(0).max(4294967295),
                    address,
                    amountAtoms: amount,
                  })
                  .strict(),
              )
              .min(1)
              .max(32),
            recipientIndices: z
              .array(z.number().int().min(3).max(8191))
              .min(1)
              .max(5),
            weightsBps: z
              .array(z.number().int().min(1).max(10000))
              .min(1)
              .max(5),
          })
          .strict(),
        children: z.array(child).min(1).max(36),
      })
      .strict(),
    recipients: z.array(address).min(1).max(5),
  })
  .strict();
export function cashoutGroup(value: unknown) {
  const g = cashoutGroupSchema.parse(value),
    p = g.plan.proposal;
  if (
    p.weightsBps.length !== p.recipientIndices.length ||
    g.recipients.length !== p.weightsBps.length ||
    p.weightsBps.reduce((a, b) => a + b, 0) !== 10000 ||
    new Set(g.recipients).size !== g.recipients.length ||
    new Set(p.recipientIndices).size !== p.recipientIndices.length ||
    new Set(p.sources.map((s) => s.address)).size !== p.sources.length ||
    p.sources.some(
      (s) =>
        !(s.kind === "swap"
          ? s.profileChainId === 0 && s.cycleIndex === 0
          : [1, 4663].includes(s.profileChainId)),
    ) ||
    p.sources.reduce((a, s) => a + BigInt(s.amountAtoms), 0n) !==
      BigInt(p.amountAtoms)
  )
    throw Error("Changed cashout group");
  let remaining = BigInt(p.amountAtoms);
  const budgets = p.weightsBps.map((w, i) => {
    const n =
      i + 1 === p.weightsBps.length
        ? remaining
        : (BigInt(p.amountAtoms) * BigInt(w)) / 10000n;
    remaining -= n;
    if (n <= 0n) throw Error("Empty receiving slot");
    return n;
  });
  const expected: z.infer<typeof child>[] = [];
  let slot = 0;
  for (const [source, s] of p.sources.entries()) {
    let left = BigInt(s.amountAtoms);
    while (left > 0n) {
      const n = left < budgets[slot]! ? left : budgets[slot]!;
      expected.push({ source, slot, amountAtoms: n.toString() });
      left -= n;
      budgets[slot]! -= n;
      if (budgets[slot] === 0n) slot++;
    }
  }
  if (JSON.stringify(g.plan.children) !== JSON.stringify(expected))
    throw Error("Changed cashout matrix");
  return g;
}
export type CashoutGroup = ReturnType<typeof cashoutGroup>;
export const cashoutGroupId = (g: CashoutGroup) =>
  createHash("sha256")
    .update("gizu-cashout-group:v1\0")
    .update(JSON.stringify(g))
    .digest("hex");
