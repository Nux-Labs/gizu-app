import type { FastifyInstance } from "fastify";

/** Leave ten seconds of margin before ECS's default 30-second forced stop. */
export function registerShutdown(app: FastifyInstance, timeoutMs = 20_000): void {
  let shuttingDown = false;
  app.addHook("onSend", async (_request, reply, payload) => {
    // Do not leave an in-flight HTTP/1 response on an idle ALB keep-alive socket.
    if (shuttingDown) reply.header("Connection", "close");
    return payload;
  });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      console.error("API_SHUTDOWN_TIMEOUT");
      process.exit(1);
    }, timeoutMs);
    try {
      await app.close();
      // Awaited close hooks need a referenced deadline even without active I/O.
      // Once closed, allow natural exit but still bound any leftover handles.
      deadline.unref();
      process.exitCode ??= 0;
    } catch {
      console.error("API_SHUTDOWN_FAILED");
      process.exit(1);
    }
  };
  // Keep both listeners installed while draining; another signal must not abort it.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
