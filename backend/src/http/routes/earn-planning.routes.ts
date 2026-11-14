import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import type { EthereumDepositPlanner } from "../../adapters/earn/ethereum-deposit-planner.ts";
import type { MonadFundingPlanner } from "../../adapters/pimlico/source-funding.ts";
import type { EthereumWithdrawalPlanner } from "../../adapters/earn/ethereum-withdrawal-planner.ts";
import type { RobinhoodDepositPlanner } from "../../adapters/earn/robinhood-deposit-planner.ts";
import type {
  RobinhoodWithdrawalPlanner,
  RobinhoodReturnPlanner,
} from "../../adapters/earn/robinhood-exit-planner.ts";
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const amount = z
  .string()
  .max(78)
  .regex(/^[1-9][0-9]*$/);
export function registerEarnPlanningRoutes(
  app: FastifyInstance,
  deposit?: Pick<EthereumDepositPlanner, "plan">,
  source?: Pick<MonadFundingPlanner, "prepare">,
  withdrawal?: Pick<EthereumWithdrawalPlanner, "plan">,
  hood?: Pick<RobinhoodDepositPlanner, "plan">,
  hoodWithdrawal?: Pick<RobinhoodWithdrawalPlanner, "plan"> &
    Partial<Pick<RobinhoodWithdrawalPlanner, "balances">>,
  hoodReturn?: Pick<RobinhoodReturnPlanner, "plan">,
) {
  if (deposit)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/ethereum/deposit-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              operationId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[-a-zA-Z0-9_]+$/),
              revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
              existingSharesScope: z.literal("include-existing").optional(),
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await deposit.plan(request.body)),
    );
  if (source)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/monad/funding-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              recipient: address,
              amount,
              budget: amount,
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(
            await source.prepare(
              request.body as Parameters<MonadFundingPlanner["prepare"]>[0],
            ),
          ),
    );
  if (withdrawal)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/ethereum/withdrawal-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              operationId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[-a-zA-Z0-9_]+$/),
              revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await withdrawal.plan(request.body)),
    );
  if (hood)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/robinhood/deposit-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              operationId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[-a-zA-Z0-9_]+$/),
              revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await hood.plan(request.body)),
    );
  if (hoodWithdrawal?.balances)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/robinhood/withdrawal-balances",
      {
        bodyLimit: 16384,
        schema: {
          body: z.object({ owners: z.array(address).min(1).max(256) }).strict(),
        },
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await hoodWithdrawal.balances!(request.body.owners)),
    );
  if (hoodWithdrawal)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/robinhood/withdrawal-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              requestedWithdrawalAtoms: amount.optional(),
              withdrawAllShares: z.literal(true).optional(),
              withdrawalRequestId: z
                .string()
                .regex(/^[-a-zA-Z0-9_]{1,128}$/)
                .optional(),
              confidentialAccount: address.optional(),
              operationId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[-a-zA-Z0-9_]+$/),
              revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await hoodWithdrawal.plan(request.body)),
    );
  if (hoodReturn)
    app.withTypeProvider<ZodTypeProvider>().post(
      "/v1/earn/robinhood/return-plan",
      {
        schema: {
          body: z
            .object({
              owner: address,
              confidentialAccount: address,
              withdrawalOperationId: z
                .string()
                .regex(/^[-a-zA-Z0-9_]{1,128}$/)
                .optional(),
              returnBudgetAtoms: amount.optional(),
              minimumRetainedUsdgAtoms: amount.optional(),
              settlementMode: z.literal("balance-delta-v1").optional(),
              operationId: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[-a-zA-Z0-9_]+$/),
              revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        },
        bodyLimit: 1024,
      },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .send(await hoodReturn.plan(request.body)),
    );
}
