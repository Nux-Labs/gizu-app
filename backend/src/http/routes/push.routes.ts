import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import { rateLimit } from "../rate-limit.ts";
import type { StrategyStore } from "../../ports/strategies.port.ts";

const deviceSchema = z
  .object({
    token: z.string().min(16).max(4096),
    platform: z.enum(["android", "ios"]),
  })
  .strict();
const deviceParams = z.object({ deviceId: z.uuid() });
const followParams = z.object({ deviceId: z.uuid(), id: z.coerce.number().int().positive() });

/**
 * Device registration for strategy update notifications. A device is a random id with no wallet
 * address; notifications carry no strategy name or weights.
 */
export function registerPushRoutes(
  app: FastifyInstance,
  store: Pick<StrategyStore, "registerPushDevice" | "followWithDevice" | "removePushDevice">,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const limitRegister = rateLimit(app, { perIp: 30, windowMs: 3_600_000 });

  routes.post(
    "/v1/push/devices",
    { schema: { body: deviceSchema }, onRequest: limitRegister },
    async (request, reply) =>
    reply
      .code(201)
      .send({ deviceId: await store.registerPushDevice(request.body.token, request.body.platform) }),
  );

  routes.put(
    "/v1/push/devices/:deviceId/strategies/:id",
    { schema: { params: followParams } },
    async (request, reply) => {
      if (!(await store.followWithDevice(request.params.deviceId, request.params.id)))
        throw new NotFoundError({ name: "Device or strategy" }, request.params.deviceId);
      return reply.code(204).send();
    },
  );

  routes.delete(
    "/v1/push/devices/:deviceId",
    { schema: { params: deviceParams } },
    async (request, reply) => {
      await store.removePushDevice(request.params.deviceId);
      return reply.code(204).send();
    },
  );
}
