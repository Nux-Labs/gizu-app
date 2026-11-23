import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { rateLimit, type RateLimit } from "../rate-limit.ts";
import type { CreateStrategyUseCase } from "../../usecase/strategies/create-strategy.usecase.ts";
import type { StrategyQueries } from "../../usecase/strategies/strategy-queries.usecase.ts";
import type { SubmitCommitUseCase } from "../../usecase/strategies/submit-commit.usecase.ts";

const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value) => value as Hex);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value): Address => getAddress(value.toLowerCase()));
/** USDC base units; up to $999,999.999999. */
const atoms = z.string().regex(/^(0|[1-9]\d{0,11})$/);

const metadataSchema = z
  .object({
    // Hashed exactly as sent, so no leading or trailing whitespace is accepted.
    name: z.string().min(1).max(48).regex(/^\S(.*\S)?$/),
    monthlyPriceAtoms: atoms,
    signalPriceAtoms: atoms,
    seats: z.number().int().min(1).max(100),
  })
  .strict();

const createSchema = z
  .object({
    signer: address,
    embargo: z.number().int().positive(),
    metadata: metadataSchema,
    deadline: z.number().int().positive(),
    signature,
  })
  .strict();

const assetSchema = z
  .object({
    chainId: z.number().int().positive(),
    kind: z.union([z.literal(0), z.literal(1)]),
    address,
    weightBps: z.number().int(),
  })
  .strict();

const commitSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    assets: z.array(assetSchema).min(1).max(10),
    assetIds: z.array(word).min(1).max(10),
    weightsBps: z.array(z.number().int()).min(1).max(10),
    salt: word,
    commitment: word,
    signature,
    deadline: z.number().int().positive(),
  })
  .strict();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  signers: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}(,0x[0-9a-fA-F]{40}){0,31}$/)
    .transform((value) => value.split(",").map((signer) => getAddress(signer.toLowerCase())))
    .optional(),
});

const HOUR_MS = 3_600_000;
/** Creation and commitments spend relayer gas; trial seats are scarce. */
export const strategyRouteLimits: Record<"create" | "commit" | "subscribe", RateLimit> = {
  create: { perIp: 10, total: 100, windowMs: HOUR_MS },
  commit: { perIp: 60, total: 600, windowMs: HOUR_MS },
  // Seats are scarce and a trial reveals the current basket, so all callers share a cap too.
  subscribe: { perIp: 20, total: 200, windowMs: HOUR_MS },
};

export function registerStrategyRoutes(
  app: FastifyInstance,
  deps: {
    create: Pick<CreateStrategyUseCase, "execute">;
    submit: Pick<SubmitCommitUseCase, "execute">;
    queries: Pick<StrategyQueries, "list" | "detail" | "subscribe" | "signal">;
  },
  limits = strategyRouteLimits,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const limitCreate = rateLimit(app, limits.create);
  const limitCommit = rateLimit(app, limits.commit);
  const limitSubscribe = rateLimit(app, limits.subscribe);

  routes.get("/v1/strategies", { schema: { querystring: listQuery } }, async (request) => ({
    list: await deps.queries.list(request.query.signers),
  }));

  routes.get("/v1/strategies/:id", { schema: { params: idParams } }, async (request) =>
    deps.queries.detail(request.params.id),
  );

  routes.post(
    "/v1/strategies",
    { schema: { body: createSchema }, onRequest: limitCreate },
    async (request, reply) => {
      const strategy = await deps.create.execute(request.body);
      return reply.code(201).send(await deps.queries.detail(strategy.id));
    },
  );

  routes.post(
    "/v1/strategies/:id/commits",
    { schema: { params: idParams, body: commitSchema }, onRequest: limitCommit },
    async (request, reply) => {
      const result = await deps.submit.execute(request.params.id, request.body);
      return reply.code(result.status === "committed" ? 201 : 202).send(result);
    },
  );

  routes.post(
    "/v1/strategies/:id/subscriptions",
    { schema: { params: idParams }, onRequest: limitSubscribe },
    async (request, reply) => reply.code(201).send(await deps.queries.subscribe(request.params.id)),
  );

  routes.get("/v1/strategies/:id/signal", { schema: { params: idParams } }, async (request) => {
    const key = request.headers["x-subscriber-key"];
    return deps.queries.signal(request.params.id, typeof key === "string" ? key : undefined);
  });
}
