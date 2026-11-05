import type {
  FastifyInstance,
  FastifyReply,
  FastifyError,
  FastifyRequest,
} from "fastify";
import {
  NativeEarnGateway,
  NativeGatewayError,
} from "../../adapters/earn/native-gateway.ts";
import { CoordinationError } from "../../adapters/earn/operation-coordinator.ts";
function failure(reply: FastifyReply, error: unknown) {
  const known = error instanceof NativeGatewayError || error instanceof CoordinationError;
  return reply.code(known ? error.statusCode : 502).send({
    code: known ? error.code : "EARN_NATIVE_UNAVAILABLE",
    message: "The native Earn request could not be verified.",
  });
}
/** Fixed native transport only; signed operations and provider credentials never enter logs. */
export function registerEarnNativeRoutes(
  app: FastifyInstance,
  gateway: NativeEarnGateway,
) {
  const options = {
    bodyLimit: 65536,
    logLevel: "silent" as const,
    errorHandler(
      error: FastifyError,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) {
      return failure(
        reply,
        new NativeGatewayError(
          error.statusCode === 413 ? 413 : 400,
          "INVALID_NATIVE_REQUEST",
        ),
      );
    },
  };
  app.post<{ Params: { chainId: string } }>(
    "/v1/earn/native/bundler/:chainId",
    options,
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        if (!["143", "4663"].includes(request.params.chainId))
          throw new NativeGatewayError(400, "INVALID_NATIVE_CHAIN");
        return reply.send(
          await gateway.bundler(
            Number(request.params.chainId),
            request.body,
            request.ip,
          ),
        );
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  for (const [route, method] of [
    ["source-quote", "sourceQuote"],
    ["source-preview", "sourcePreview"],
    ["return-quote", "returnQuote"],
  ] as const)
    app.post(
      `/v1/earn/native/${route}`,
      { ...options, bodyLimit: 2048 },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
          return reply.send(
            await gateway[method](
              request.body as Parameters<NativeEarnGateway[typeof method]>[0],
              request.ip,
            ),
          );
        } catch (error) {
          return failure(reply, error);
        }
      },
    );
  app.post(
    "/v1/earn/native/quote-binding",
    { ...options, bodyLimit: 196608 },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return reply.send(
          gateway.quoteBinding(
            request.body as Parameters<NativeEarnGateway["quoteBinding"]>[0],
          ),
        );
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
}
