import { buildApp } from "./app.ts";
import { parseApiEnv } from "./env.schema.ts";
import { resolveEnv } from "./secret/env-file.ts";
import { registerShutdown } from "./shutdown.ts";

const Secret = parseApiEnv(resolveEnv());

try {
  const app = await buildApp(Secret);
  registerShutdown(app);
  await app.listen({ port: Secret.PORT, host: "0.0.0.0" });
} catch {
  console.error("API_STARTUP_FAILED");
  process.exit(1);
}
