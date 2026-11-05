import {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
export const privateHttpOptions = {
  logController: new LogController({ disableRequestLogging: true }),
} satisfies FastifyServerOptions;
export function isPrivateRoute(url: string | undefined) {
  return (
    !!url &&
    (url.startsWith("/wallet-recovery/") ||
      url.startsWith("/v1/earn/") ||
      (url.startsWith("/v1/swap/") && url !== "/v1/swap/aurora/tokens"))
  );
}
/** All incoming URLs may contain private path/query data, including unknown
 * routes. Fastify's automatic raw-URL logger is disabled globally. */
export function registerPrivateHttp(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (isPrivateRoute(request.routeOptions.url ?? request.url))
      reply.header("Cache-Control", "no-store");
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route && isPrivateRoute(route))
      app.log.info(
        {
          event: "private.request",
          route,
          status: reply.statusCode,
          elapsedMs: Math.round(reply.elapsedTime),
        },
        "private request",
      );
  });
}
