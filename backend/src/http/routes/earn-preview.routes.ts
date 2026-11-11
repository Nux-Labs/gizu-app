import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { payoutLegSchema } from "../../adapters/earn/distribution.ts";
import type { RobinhoodDepositPreviewPlanner } from "../../adapters/earn/robinhood-deposit-preview.ts";
import type { EarnPayoutPreviewGateway } from "../../adapters/earn/payout-preview.ts";
const addr = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((v) => !/^0x0{40}$/i.test(v));
const atoms = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const binding = {
  operationId: z.string().regex(/^[-a-zA-Z0-9_]{1,128}$/),
  revision: z.number().int().min(1).max(2147483647),
};
export function registerEarnPreviewRoutes(
  app: FastifyInstance,
  deposit: Pick<RobinhoodDepositPreviewPlanner, "preview">,
  payout: Pick<EarnPayoutPreviewGateway, "preview">,
) {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/earn/robinhood/deposit-preview",
    {
      bodyLimit: 2048,
      logLevel: "silent",
      schema: {
        body: z
          .object({
            ...binding,
            owner: addr,
            expectedUsdgAtoms: atoms,
            startingUsdgAtoms: z
              .string()
              .regex(/^(0|[1-9][0-9]{0,77})$/)
              .refine((v) => BigInt(v) < 1n << 256n)
              .optional(),
          })
          .strict(),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await deposit.preview(request.body);
      } catch {
        return reply.code(503).send({
          code: "EARN_DEPOSIT_PREVIEW_UNAVAILABLE",
          message:
            "Fresh deposit estimates are unavailable. Saved progress is preserved.",
        });
      }
    },
  );
  app.withTypeProvider<ZodTypeProvider>().post(
    "/v1/earn/native/payout/preview",
    {
      bodyLimit: 2048,
      logLevel: "silent",
      schema: {
        body: z
          .object({
            ...binding,
            profileChainId: z.literal(4663),
            confidentialAccount: addr,
            recipient: addr,
            amountAtoms: atoms,
            leg: payoutLegSchema,
          })
          .strict(),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await payout.preview(request.body);
      } catch {
        return reply.code(503).send({
          code: "EARN_DEPOSIT_PREVIEW_UNAVAILABLE",
          message: "This USDG route is unavailable. No funds have moved.",
        });
      }
    },
  );
}
