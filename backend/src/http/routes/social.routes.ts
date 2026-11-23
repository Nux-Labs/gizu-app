import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { COMMENT_MAX_LENGTH, COMMENT_REPORT_REASON_MAX_LENGTH } from "../../domain/social.ts";
import { rateLimit, type RateLimit } from "../rate-limit.ts";
import { optionalSession, requireSession, type SessionLookup } from "../social-auth.ts";
import type { SocialSessions } from "../../usecase/social/social-sessions.usecase.ts";
import type { StrategySocial } from "../../usecase/social/strategy-social.usecase.ts";
import type { StrategyQueries } from "../../usecase/strategies/strategy-queries.usecase.ts";

const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((value) => value as Hex);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value): Address => getAddress(value.toLowerCase()));
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seq = z.coerce.number().int().nonnegative().max(2 ** 31 - 1);
const limit = z.coerce.number().int().min(1).max(50).default(20);
const cursor = z.string().min(1).max(512);

const sessionSchema = z
  .object({
    account: address,
    nonce: word,
    issuedAt: z.number().int().nonnegative(),
    signature,
    ownerLink: z.object({ strategyId: id, signature }).strict().optional(),
  })
  .strict();

const strategyParams = z.object({ id });
const commentParams = z.object({ id });
// A request without a body arrives as null.
const likeBody = z.object({ seq: seq.optional() }).strict().nullish();
const seqQuery = z.object({ seq: seq.optional() });
const commentsQuery = z.object({ seq: seq.optional(), cursor: cursor.optional(), limit });
const commentBody = z
  .object({
    body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
    seq: seq.optional(),
    parentId: id.optional(),
  })
  .strict();
const reportBody = z
  .object({ reason: z.string().max(COMMENT_REPORT_REASON_MAX_LENGTH).optional() })
  .strict()
  .nullish();
const feedQuery = z.object({
  strategies: z
    .string()
    .regex(/^[1-9]\d{0,15}(,[1-9]\d{0,15}){0,99}$/)
    .transform((value) => value.split(",").map(Number))
    .optional(),
  cursor: cursor.optional(),
  limit,
});

const MINUTE_MS = 60_000;
/**
 * Per-IP limits in front of the per-account comment limits, which the store enforces. Challenges
 * and sessions write rows, so callers share a total cap too.
 */
export const socialRouteLimits: Record<"challenge" | "session" | "like" | "comment", RateLimit> = {
  challenge: { perIp: 30, total: 1200, windowMs: MINUTE_MS },
  session: { perIp: 30, total: 1200, windowMs: MINUTE_MS },
  like: { perIp: 120, windowMs: MINUTE_MS },
  comment: { perIp: 60, windowMs: MINUTE_MS },
};

/** Sign-in with the social key, likes, comments and the public update feed. */
export function registerSocialRoutes(
  app: FastifyInstance,
  deps: {
    sessions: Pick<SocialSessions, "challenge" | "signIn"> & SessionLookup;
    social: Pick<StrategySocial, "like" | "comments" | "post" | "remove" | "report" | "hide">;
    queries: Pick<StrategyQueries, "feed">;
  },
  limits = socialRouteLimits,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const limitChallenge = rateLimit(app, limits.challenge);
  const limitSession = rateLimit(app, limits.session);
  const limitLike = rateLimit(app, limits.like);
  const limitComment = rateLimit(app, limits.comment);
  const session = (request: Parameters<typeof requireSession>[0]) => requireSession(request, deps.sessions);

  routes.post("/v1/social/challenge", { onRequest: limitChallenge }, async (_request, reply) =>
    reply.code(201).send(await deps.sessions.challenge()),
  );

  routes.post(
    "/v1/social/sessions",
    { schema: { body: sessionSchema }, onRequest: limitSession },
    async (request, reply) => reply.code(201).send(await deps.sessions.signIn(request.body)),
  );

  routes.put(
    "/v1/strategies/:id/likes",
    { schema: { params: strategyParams, body: likeBody }, onRequest: limitLike },
    async (request) =>
      deps.social.like(await session(request), request.params.id, request.body?.seq, true),
  );

  routes.delete(
    "/v1/strategies/:id/likes",
    { schema: { params: strategyParams, querystring: seqQuery }, onRequest: limitLike },
    async (request) =>
      deps.social.like(await session(request), request.params.id, request.query.seq, false),
  );

  routes.get(
    "/v1/strategies/:id/comments",
    { schema: { params: strategyParams, querystring: commentsQuery } },
    async (request, reply) => {
      const viewer = await optionalSession(request, reply, deps.sessions);
      return deps.social.comments(request.params.id, request.query, viewer);
    },
  );

  routes.post(
    "/v1/strategies/:id/comments",
    { schema: { params: strategyParams, body: commentBody }, onRequest: limitComment },
    async (request, reply) =>
      reply.code(201).send(await deps.social.post(await session(request), request.params.id, request.body)),
  );

  routes.delete(
    "/v1/comments/:id",
    { schema: { params: commentParams }, onRequest: limitComment },
    async (request, reply) => {
      await deps.social.remove(await session(request), request.params.id);
      return reply.code(204).send();
    },
  );

  routes.post(
    "/v1/comments/:id/report",
    { schema: { params: commentParams, body: reportBody }, onRequest: limitComment },
    async (request, reply) => {
      await deps.social.report(await session(request), request.params.id, request.body?.reason);
      return reply.code(204).send();
    },
  );

  routes.post(
    "/v1/comments/:id/hide",
    { schema: { params: commentParams }, onRequest: limitComment },
    async (request, reply) => {
      await deps.social.hide(await session(request), request.params.id);
      return reply.code(204).send();
    },
  );

  routes.get("/v1/feed", { schema: { querystring: feedQuery } }, async (request, reply) => {
    const viewer = await optionalSession(request, reply, deps.sessions);
    return deps.queries.feed(
      {
        ...(request.query.strategies ? { strategyIds: request.query.strategies } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        limit: request.query.limit,
      },
      viewer?.account ?? null,
    );
  });
}
