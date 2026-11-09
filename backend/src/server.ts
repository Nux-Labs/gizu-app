import { buildApp } from "./app.ts";
import { parseApiEnv } from "./env.schema.ts";
import { resolveEnv } from "./secret/env-file.ts";

const Secret = parseApiEnv(resolveEnv());

try {
  const app = await buildApp(Secret);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Compose allows 75s. Stop accepting connections, drain requests and close
    // pools; active fork requests run their existing finally/child teardown.
    const deadline = setTimeout(() => process.exit(1), 70_000);
    deadline.unref();
    try {
      await app.close();
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch {
      console.error("API_SHUTDOWN_FAILED");
      process.exit(1);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await app.listen({ port: Secret.PORT, host: "0.0.0.0" });
} catch {
  console.error("API_STARTUP_FAILED");
  process.exit(1);
}
