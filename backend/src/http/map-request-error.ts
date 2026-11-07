import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { isPrivateRoute } from "./private-http.ts";
import { DomainError } from "../domain/errors/domain-error.ts";
import { GasPolicyError } from "../adapters/evm/gas-errors.ts";
import { InfrastructureError } from "../domain/errors/infrastructure-error.ts";
import { NotFoundError } from "../domain/errors/not-found-error.ts";

export function mapRequestError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (isPrivateRoute(request.routeOptions.url ?? request.url)) {
    const validation =
      error instanceof ZodError ||
      !!error.validation ||
      (error.statusCode ?? 500) < 500;
    const known =
      error instanceof InfrastructureError || error instanceof DomainError;
    const code =
      known && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : validation
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR";
    const status =
      error instanceof NotFoundError
        ? 404
        : error instanceof InfrastructureError
          ? error.statusCode
          : error instanceof DomainError
            ? 400
            : error.statusCode === 413
              ? 413
              : validation
                ? 400
                : 500;
    request.log.error(
      {
        event: request.routeOptions.url?.startsWith("/v1/swap/")
          ? "swap.error"
          : "private.error",
        code,
        route: request.routeOptions.url ?? "unmatched",
      },
      "private request failed",
    );
    return reply.header("Cache-Control", "no-store").code(status).send({
      code,
      message: "The private request could not be completed.",
      ...(error instanceof GasPolicyError ? { retryable: false } : {}),
    });
  }
  const logError = () =>
    request.log.error(
      {
        code: "INTERNAL_ERROR",
        route: request.routeOptions.url ?? "unmatched",
      },
      "request failed",
    );
  if (error instanceof NotFoundError) {
    return reply.code(404).send({ code: error.code, message: error.message });
  }
  if (error instanceof DomainError) {
    return reply.code(400).send({ code: error.code, message: error.message });
  }
  if (error instanceof InfrastructureError) {
    logError();
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message });
  }
  if (error instanceof ZodError || error.validation) {
    logError();
    return reply
      .code(400)
      .send({ code: "VALIDATION_ERROR", message: "invalid request" });
  }
  logError();
  return reply
    .code(500)
    .send({ code: "INTERNAL_ERROR", message: "unexpected error" });
}
