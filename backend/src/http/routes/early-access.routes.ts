import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { EarlyAccess } from "../../ports/early-access.port.ts";

const signupSchema = z.object({
  email: z.string().trim().max(254).email().transform((email) => email.toLowerCase()),
  investmentRange: z.string().trim().max(100).optional(),
  platforms: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  otherPlatform: z.string().trim().max(500).optional(),
}).strict();

export function registerEarlyAccessRoutes(
  app: FastifyInstance,
  signups: EarlyAccess,
  development = false,
) {
  const origins = new Set(["https://gizu.io", "https://www.gizu.io", "https://app.gizu.io"]);
  if (development) {
    for (const host of ["localhost", "127.0.0.1"]) {
      origins.add(`http://${host}:5173`);
    }
  }

  // Bound the public signup endpoint without recording IPs in the database.
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const windowMs = 60_000;
  const cleanup = setInterval(() => {
    for (const [ip, entry] of attempts) {
      if (entry.expiresAt <= Date.now()) attempts.delete(ip);
    }
  }, windowMs);
  cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); });

  const cors = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (!origin) return;
    if (!origins.has(origin)) {
      return reply.code(403).send({ code: "ORIGIN_NOT_ALLOWED", message: "origin not allowed" });
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  };

  app.options("/v1/early-access", { onRequest: cors }, async (_request, reply) => reply.code(204).send());
  app.post("/v1/early-access", {
    bodyLimit: 4096,
    onRequest: [cors, async (request, reply) => {
      const now = Date.now();
      let entry = attempts.get(request.ip);
      if (!entry || entry.expiresAt <= now) {
        entry = { count: 0, expiresAt: now + windowMs };
        attempts.set(request.ip, entry);
      }
      if (++entry.count > 10) {
        reply.header("Retry-After", Math.ceil((entry.expiresAt - now) / 1000));
        return reply.code(429).send({ code: "TOO_MANY_REQUESTS", message: "please try again shortly" });
      }
    }],
  }, async (request, reply) => {
    const signup = signupSchema.safeParse(request.body);
    if (!signup.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR", message: "enter a valid email address" });
    }
    try {
      await signups.add(signup.data);
      return reply.header("Cache-Control", "no-store").send({ status: "registered" });
    } catch {
      request.log.error({ code: "SIGNUP_UNAVAILABLE" }, "early access signup could not be saved");
      return reply.code(503).send({ code: "SIGNUP_UNAVAILABLE", message: "we could not save your email; please try again" });
    }
  });
}
