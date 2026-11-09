import { cashoutGroupSchema } from "../../adapters/earn/cashout-group.ts";
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
function registerConfidentialPayoutRoutes(
  app: FastifyInstance,
  gateway: Pick<ConfidentialCashoutGateway, "prepare" | "status">,
  purpose: "cashout" | "private-funding",
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
      "/v1/earn/native/" + purpose + "/" + method,
      { bodyLimit: 196608, logLevel: "silent" },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({
            code:
              purpose === "cashout"
                ? "INVALID_CASHOUT_REQUEST"
                : "INVALID_PRIVATE_FUNDING_REQUEST",
          });
        try {
          const receiptOnly =
            purpose === "cashout" &&
            request.headers["x-gizu-payout-proof"] === "destination-receipt-v1";
          return await gateway[method](parsed.data, receiptOnly);
        } catch {
          return reply.code(503).send({
            code:
              purpose === "cashout"
                ? "CONFIDENTIAL_CASHOUT_UNAVAILABLE"
                : "CONFIDENTIAL_PRIVATE_FUNDING_UNAVAILABLE",
            message:
              purpose === "cashout"
                ? "Fresh authenticated cashout evidence is unavailable. Resume the saved native withdrawal."
                : "Fresh authenticated private funding evidence is unavailable. Resume the saved native deposit.",
          });
        }
      },
    );
}

export function registerConfidentialCashoutRoutes(
  app: FastifyInstance,
  gateway: Pick<
    ConfidentialCashoutGateway,
    "prepare" | "status" | "prepareGroup" | "groupStatus"
  >,
) {
  registerConfidentialPayoutRoutes(app, gateway, "cashout");
  const child = z
    .object({
      recoveryEnvelope: z.string().min(1).max(180000),
      submittedIntent: signed,
      intentHash: z.string().min(1).max(256).optional(),
    })
    .strict();
  const prepare = z
    .object({
      group: cashoutGroupSchema,
      childIndex: z.number().int().min(0).max(35),
      signedData: signed,
      anchor: z.string().min(1).max(180000).optional(),
    })
    .strict();
  const status = z
    .object({
      group: cashoutGroupSchema,
      owners: z.array(signed).min(1).max(32),
      children: z.array(child.nullable()).min(1).max(36),
      destinationTransactionHashes: z
        .array(z.array(z.string().regex(/^0x[0-9a-f]{64}$/i)).max(128))
        .min(1)
        .max(5),
    })
    .strict();
  for (const [path, method, schema] of [
    ["group-prepare", "prepareGroup", prepare],
    ["group-status", "groupStatus", status],
  ] as const)
    app.post(
      "/v1/earn/native/cashout/" + path,
      { bodyLimit: 8 * 1024 * 1024, logLevel: "silent" },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = schema.safeParse(request.body);
        if (
          request.headers["x-gizu-payout-proof"] !==
            "destination-receipt-group-v1" ||
          !parsed.success
        )
          return reply
            .code(400)
            .send({ code: "INVALID_CASHOUT_GROUP_REQUEST" });
        try {
          return await gateway[method](parsed.data);
        } catch {
          return reply.code(503).send({
            code: "CONFIDENTIAL_CASHOUT_UNAVAILABLE",
            message:
              "Resume the saved native withdrawal to verify public delivery.",
          });
        }
      },
    );
}
export function registerConfidentialPrivateFundingRoutes(
  app: FastifyInstance,
  gateway: Pick<ConfidentialCashoutGateway, "prepare" | "status">,
) {
  registerConfidentialPayoutRoutes(app, gateway, "private-funding");
}
