import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";

type Message = { type: string; address?: string };
function fixture(t: TestContext, mode = "normal") {
  const child = fork(new URL("./fixtures/shutdown-server.ts", import.meta.url), {
    execArgv: ["--experimental-transform-types"],
    env: { ...process.env, SHUTDOWN_TEST_MODE: mode },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  const messages: Message[] = [];
  child.on("message", (message) => { messages.push(message as Message); });
  const ready = once(child, "message").then(([message]) => message as Message);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return { child, ready, exited, messages, stderr: () => stderr };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} closes the server and runs its close hooks`, { timeout: 8_000 }, async (t) => {
    const running = fixture(t);
    await running.ready;
    running.child.kill(signal);
    assert.deepEqual(await running.exited, { code: 0, signal: null });
    assert.equal(running.messages.filter((message) => message.type === "closed").length, 1);
  });
}

test("shutdown drains an active HTTP request and ignores repeated signals", { timeout: 8_000 }, async (t) => {
  const running = fixture(t);
  const { address } = await running.ready;
  const started = once(running.child, "message");
  const response = fetch(`${address}/slow`);
  assert.equal((await started)[0].type, "request-started");
  const closing = once(running.child, "message");
  running.child.kill("SIGTERM");
  assert.equal((await closing)[0].type, "closing");
  running.child.kill("SIGTERM");
  running.child.kill("SIGINT");
  running.child.send("release");
  const finished = await response;
  assert.deepEqual(await finished.json(), { status: "finished" });
  assert.equal(finished.headers.get("connection"), "close");
  assert.deepEqual(await running.exited, { code: 0, signal: null });
  assert.equal(running.messages.filter((message) => message.type === "closing").length, 1);
  assert.equal(running.messages.filter((message) => message.type === "closed").length, 1);
});

test("a failing close hook exits with failure without logging credentials", { timeout: 8_000 }, async (t) => {
  const running = fixture(t, "error");
  await running.ready;
  running.child.kill("SIGTERM");
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.match(running.stderr(), /API_SHUTDOWN_FAILED/);
  assert.equal(running.stderr().includes("private-credentials"), false);
});

test("a hung close hook is terminated at the shutdown deadline", { timeout: 8_000 }, async (t) => {
  const running = fixture(t, "hang");
  await running.ready;
  running.child.kill("SIGTERM");
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.match(running.stderr(), /API_SHUTDOWN_TIMEOUT/);
});

test("leftover handles cannot keep the process alive after its shutdown deadline", { timeout: 2_000 }, async (t) => {
  const running = fixture(t, "orphan");
  await running.ready;
  running.child.kill("SIGTERM");
  assert.deepEqual(await running.exited, { code: 1, signal: null });
  assert.match(running.stderr(), /API_SHUTDOWN_TIMEOUT/);
});
