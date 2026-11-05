import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConfidentialCashoutGateway } from "../../adapters/earn/confidential-cashout.ts";
const signed = z
  .object({
    standard: z.literal("erc191"),
    payload: z.string().min(1).max(8000),
    signature: z.string().regex(/^secp256k1:[1-9A-HJ-NP-Za-km-z]{86,90}$/),
  })
  .strict();
export function registerConfidentialCashoutRoutes(
  app: FastifyInstance,
  gateway: Pick<ConfidentialCashoutGateway, "prepare" | "status">,
) {
  const prepare = z
    .object({
      operationId: z.string().regex(/^[-a-zA-Z0-9_]{1,128}$/),
      amountAtoms: z.string().regex(/^[1-9][0-9]{0,77}$/),
      recipient: z.string().regex(/^0x[0-9a-f]{40}$/i),
      signedData: signed,
    })
    .strict();
  const status = z
    .object({
      recoveryEnvelope: z.string().min(1).max(180000),
      signedData: signed,
      submittedIntent: signed,
      intentHash: z.string().min(1).max(256).optional(),
      destinationTransactionHash: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/i)
        .optional(),
    })
    .strict();
  for (const [method, schema] of [
    ["prepare", prepare],
    ["status", status],
  ] as const)
    app.post(
      "/v1/earn/native/cashout/" + method,
      { bodyLimit: 196608, logLevel: "silent" },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "INVALID_CASHOUT_REQUEST" });
        try {
          return await gateway[method](parsed.data);
        } catch {
          return reply.code(503).send({
            code: "CONFIDENTIAL_CASHOUT_UNAVAILABLE",
            message:
              "Fresh authenticated cashout evidence is unavailable. Resume the saved native withdrawal.",
          });
        }
      },
    );
}
