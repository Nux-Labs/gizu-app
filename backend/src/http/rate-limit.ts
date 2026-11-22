import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type RateLimit = {
  /** Requests one IP may make per window. */
  perIp: number;
  /** Requests all callers together may make per window; bounds spend that IP rotation evades. */
  total?: number;
  windowMs: number;
};

/**
 * In-memory fixed-window limiter, as on the early-access route: IPs are never stored in the
 * database, and each instance limits independently.
 */
export function rateLimit(app: FastifyInstance, limit: RateLimit) {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key);
  }, limit.windowMs);
  cleanup.unref();
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
  });

  const take = (key: string, max: number, now: number) => {
    let bucket = buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + limit.windowMs };
      buckets.set(key, bucket);
    }
    return ++bucket.count > max ? bucket : null;
  };

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const exceeded =
      take(`ip:${request.ip}`, limit.perIp, now) ??
      (limit.total === undefined ? null : take("*", limit.total, now));
    if (exceeded) {
      reply.header("Retry-After", Math.ceil((exceeded.expiresAt - now) / 1000));
      return reply.code(429).send({ code: "TOO_MANY_REQUESTS", message: "please try again shortly" });
    }
  };
}
