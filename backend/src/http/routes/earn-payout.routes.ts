import type {
  FastifyInstance,
  FastifyReply,
  FastifyError,
  FastifyRequest,
} from "fastify";
import { PrivatePayoutGateway } from "../../adapters/earn/private-payout.ts";
import { NativeGatewayError } from "../../adapters/earn/native-gateway.ts";
import { CoordinationError } from "../../adapters/earn/operation-coordinator.ts";
function failure(reply: FastifyReply, error: unknown) {
  const known = error instanceof NativeGatewayError || error instanceof CoordinationError;
  return reply.code(known ? error.statusCode : 502).send({
    code: known ? error.code : "EARN_PRIVATE_PAYOUT_UNAVAILABLE",
    message:
      "The private payout could not be verified. Reconcile the saved native record before proceeding.",
  });
}
/** These payloads are fetched by the native signer over TLS, never relayed to Expo. */
export function registerEarnPayoutRoutes(
  app: FastifyInstance,
  gateway: PrivatePayoutGateway,
) {
  const options = {
    bodyLimit: 262144, // Native-private encrypted recovery envelope plus exact auth/payload.
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
          "INVALID_PRIVATE_PAYOUT_REQUEST",
        ),
      );
    },
  };
  for (const [route, method] of [
    ["prepare", "prepare"],
    ["submit", "submit"],
    ["settlement", "reconcile"],
  ] as const)
    app.post(
      `/v1/earn/native/payout/${route}`,
      options,
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
          const body = request.body;
          const result =
            method === "prepare"
              ? await gateway.prepare(
                  body as Parameters<PrivatePayoutGateway["prepare"]>[0],
                  request.ip,
                )
              : method === "submit"
                ? await gateway.submit(
                    body as Parameters<PrivatePayoutGateway["submit"]>[0],
                    request.ip,
                  )
                : await gateway.reconcile(
                    body as Parameters<PrivatePayoutGateway["reconcile"]>[0],
                    request.ip,
                  );
          return reply.send(result);
        } catch (error) {
          return failure(reply, error);
        }
      },
    );
  for (const [route, method] of [
    ["prepare", "prepareWithdrawal"],
    ["submit", "submitWithdrawal"],
    ["status", "reconcileWithdrawal"],
  ] as const) {
    app.post(
      `/v1/earn/native/withdrawal/${route}`,
      options,
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
          return reply.send(
            await gateway[method](request.body as never, request.ip),
          );
        } catch (error) {
          return failure(reply, error);
        }
      },
    );
  }
}
