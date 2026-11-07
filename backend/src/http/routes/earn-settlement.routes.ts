import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import type { ConfidentialSettlement } from "../../adapters/aurora/settlement.ts";
const address = z.string().regex(/^0x[0-9a-f]{40}$/i),
  amount = z
    .string()
    .max(78)
    .regex(/^[1-9][0-9]*$/);
export function registerEarnSettlementRoutes(
  app: FastifyInstance,
  settlement: Pick<ConfidentialSettlement, "read" | "baseline">,
) {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/earn/native/settlement",
    {
      bodyLimit: 196608,
      logLevel: "silent",
      schema: {
        body: z
          .object({
            signedData: z
              .object({
                standard: z.literal("erc191"),
                payload: z.string().min(1).max(2048),
                signature: z.string().min(1).max(128),
              })
              .strict(),
            expected: z
              .object({
                operationId: z
                  .string()
                  .min(1)
                  .max(128)
                  .regex(/^[-a-zA-Z0-9_]+$/),
                revision: z
                  .number()
                  .int()
                  .positive()
                  .max(Number.MAX_SAFE_INTEGER),
                depositAddress: address,
                sourceOwner: address,
                confidentialAccount: address,
                originAsset: z.string().min(1).max(256),
                amountAtoms: amount,
                minimumCreditAtoms: amount,
                transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
                maximumCreditAtoms: amount.optional(),
                baselineEnvelope: z.string().min(1).max(16384).optional(),
                quoteEnvelope: z.string().min(1).max(65536).optional(),
                settlementEnvelope: z.string().min(1).max(131072).optional(),
              })
              .strict(),
          })
          .strict(),
      },
    },
    async (request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send(
          await settlement.read(
            request.body.signedData,
            request.body.expected,
            request.headers["x-gizu-settlement-proof"] ===
              "operation-history-v1",
          ),
        ),
  );
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/earn/native/settlement-baseline",
    {
      bodyLimit: 8192,
      logLevel: "silent",
      schema: {
        body: z
          .object({
            signedData: z
              .object({
                standard: z.literal("erc191"),
                payload: z.string().min(1).max(2048),
                signature: z.string().min(1).max(128),
              })
              .strict(),
          })
          .strict(),
      },
    },
    async (request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send(await settlement.baseline(request.body.signedData)),
  );
}
