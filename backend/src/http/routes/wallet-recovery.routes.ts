import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WalletRecoveryStore } from "../../ports/wallet-recovery.port.ts";
import type { RecoveryUploadAdmission } from "../../ports/recovery-upload-admission.port.ts";
const hex = /^[0-9a-f]{64}$/;
const maxBytes = 1048576;
const input = z
  .object({
    expectedRevision: z.number().int().min(0).max(2147483646),
    ciphertext: z
      .string()
      .min(16)
      .max(Math.ceil((maxBytes * 4) / 3))
      .regex(/^[A-Za-z0-9_-]+$/)
      .refine((value) => {
        const bytes = Buffer.from(value, "base64url");
        return (
          bytes.length <= maxBytes && bytes.toString("base64url") === value
        );
      }),
  })
  .strict();
function fail(reply: FastifyReply, status: number) {
  return reply.code(status).send({
    code:
      status === 429
        ? "RECOVERY_UPLOAD_LIMIT"
        : status === 404
          ? "RECOVERY_NOT_FOUND"
          : status === 409
            ? "RECOVERY_CONFLICT"
            : status === 507
              ? "RECOVERY_QUOTA_EXCEEDED"
              : status === 503
                ? "RECOVERY_UNAVAILABLE"
                : "INVALID_RECOVERY_REQUEST",
  });
}
export function registerWalletRecoveryRoutes(
  app: FastifyInstance,
  store: WalletRecoveryStore,
  admission?: RecoveryUploadAdmission,
) {
  const options = {
    bodyLimit: 1398400,
    logLevel: "silent" as const,
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      const id = (request.params as { id?: unknown }).id;
      if (
        typeof id !== "string" ||
        !hex.test(id) ||
        !/^Bearer [0-9a-f]{64}$/.test(request.headers.authorization ?? "")
      )
        return fail(reply, 404);
      if (request.method === "PUT") {
        if (
          !/^application\/json(?:\s*;.*)?$/i.test(
            request.headers["content-type"] ?? "",
          ) ||
          (request.headers["content-encoding"] !== undefined &&
            request.headers["content-encoding"] !== "identity")
        )
          return fail(reply, 415);
        if (Number(request.headers["content-length"] ?? 0) > 1398400)
          return fail(reply, 413);
      }
    },
    errorHandler: (
      error: { statusCode?: number },
      _request: unknown,
      reply: FastifyReply,
    ) => fail(reply, error.statusCode === 413 ? 413 : 400),
  };
  for (const method of ["GET", "PUT", "DELETE"] as const)
    app.route<{ Params: { id: string } }>({
      method,
      url: "/wallet-recovery/v1/:id",
      ...options,
      handler: async (request, reply) => {
        const id = request.params.id;
        const match = /^Bearer ([0-9a-f]{64})$/.exec(
          request.headers.authorization ?? "",
        );
        if (!hex.test(id) || !match) return fail(reply, 404);
        const digest = createHash("sha256")
          .update(`gizu-wallet-recovery-auth:v1\0${match[1]}`)
          .digest("hex");
        try {
          if (method === "DELETE") {
            await store.remove(id, digest);
            return reply.code(204).send();
          }
          if (method === "GET") {
            const snapshot = await store.read(id, digest);
            return snapshot ? reply.send(snapshot) : fail(reply, 404);
          }
          const parsed = input.safeParse(request.body);
          if (!parsed.success) return fail(reply, 400);
          if (
            admission &&
            !(await admission.admit(
              request.ip,
              Buffer.from(parsed.data.ciphertext, "base64url").length,
            ))
          )
            return fail(reply, 429);
          const result = await store.write(
            id,
            digest,
            parsed.data.expectedRevision,
            parsed.data.ciphertext,
          );
          return result.status === "ok"
            ? reply.send(result.snapshot)
            : fail(
                reply,
                result.status === "quota"
                  ? 507
                  : result.status === "conflict"
                    ? 409
                    : 404,
              );
        } catch {
          return fail(reply, 503);
        }
      },
    });
}
