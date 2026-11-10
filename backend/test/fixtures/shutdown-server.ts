import Fastify from "fastify";
import { registerShutdown } from "../../src/shutdown.ts";

const app = Fastify();
const mode = process.env.SHUTDOWN_TEST_MODE;
let release: (() => void) | undefined;
app.get("/slow", async () => {
  process.send?.({ type: "request-started" });
  await new Promise<void>((resolve) => { release = resolve; });
  return { status: "finished" };
});
app.addHook("preClose", async () => { process.send?.({ type: "closing" }); });
app.addHook("onClose", async () => {
  if (mode === "hang") {
    process.disconnect();
    await new Promise<void>(() => {});
  }
  if (mode === "orphan") setInterval(() => {}, 60_000);
  if (mode === "error") throw new Error("postgres://private-credentials@private-host");
  process.send?.({ type: "closed" });
  process.disconnect();
});
process.on("message", (message) => { if (message === "release") release?.(); });
registerShutdown(app, mode === "hang" || mode === "orphan" ? 100 : 2_000);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ type: "ready", address });
