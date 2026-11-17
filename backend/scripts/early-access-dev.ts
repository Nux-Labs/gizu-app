import Fastify from "fastify";
import { createPgPool } from "../src/adapters/postgres/pg-pool.ts";
import { PgEarlyAccess } from "../src/adapters/postgres/pg-early-access.ts";
import { registerEarlyAccessRoutes } from "../src/http/routes/early-access.routes.ts";

// Local signup preview using the production route and adapter, without wallet/provider services.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("Set TEST_DATABASE_URL to a local PostgreSQL database.");
}
const pool = createPgPool(databaseUrl);
await pool.query("SELECT 1");
const app = Fastify();
registerEarlyAccessRoutes(app, new PgEarlyAccess(pool), true);
app.addHook("onClose", () => pool.end());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ host: "127.0.0.1", port: 3000 });
console.log("Local signup API: http://127.0.0.1:3000/v1/early-access (local database only)");
