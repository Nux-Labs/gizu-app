import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { FcmPushSender } from "../../src/adapters/push/fcm-push-sender.ts";
import { PushDelivery, pushRef } from "../../src/usecase/strategies/push-delivery.usecase.ts";
import type { PendingPush, PushOutcome } from "../../src/ports/strategies.port.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  project_id: "gizu-test",
  client_email: "push@gizu-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const message = { token: "device-token", platform: "android" as const, ref: "a".repeat(32) };

function fakeFcm(replies: { status: number; body?: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token")
      return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), { status: 200 });
    const reply = replies.shift() ?? { status: 200, body: { name: "projects/gizu-test/messages/1" } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("FCM messages are neutral, collapse per strategy and reuse one signed access token", async () => {
  const fcm = fakeFcm([]);
  const sender = new FcmPushSender(account, fcm.fetchImpl, () => 1_800_000_000_000);
  assert.equal(await sender.send(message), "sent");
  assert.equal(await sender.send(message), "sent");
  const [auth, send] = fcm.calls;
  assert.equal(fcm.calls.filter((call) => call.url.includes("oauth2")).length, 1, "token reused");

  // The assertion is a JWT signed by the service account for the FCM scope.
  const form = new URLSearchParams(auth!.init.body as URLSearchParams);
  const [header, claims, signature] = form.get("assertion")!.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url")));
  const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
  assert.equal(payload.iss, account.client_email);
  assert.equal(payload.scope, "https://www.googleapis.com/auth/firebase.messaging");

  assert.equal(send!.url, "https://fcm.googleapis.com/v1/projects/gizu-test/messages:send");
  assert.equal((send!.init.headers as Record<string, string>).authorization, "Bearer access-1");
  const body = JSON.parse(send!.init.body as string);
  assert.equal(body.message.token, "device-token");
  assert.deepEqual(body.message.data, { type: "strategy-update", ref: message.ref });
  assert.equal(body.message.android.collapse_key, message.ref);
  assert.equal(body.message.android.notification.tag, message.ref);
  assert.doesNotMatch(JSON.stringify(body), /strategyId|weight/);
});

test("FCM outcomes: unregistered tokens, rejected messages and retryable outages", async () => {
  const unregistered = {
    status: 404,
    body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
  };
  const fcm = fakeFcm([unregistered, { status: 404, body: { error: { status: "NOT_FOUND" } } }, { status: 400 }, { status: 503 }]);
  const sender = new FcmPushSender(account, fcm.fetchImpl);
  assert.equal(await sender.send(message), "unregistered");
  assert.equal(await sender.send(message), "failed", "a bare 404 never removes a device");
  assert.equal(await sender.send(message), "failed");
  await assert.rejects(sender.send(message), /FCM unavailable \(503\)/);
});

test("delivery sends the newest update per device, drops dead tokens and keeps the queue on outages", async () => {
  const pending: PendingPush[] = [
    { deviceId: "d1", token: "t1", platform: "android", strategyId: 1, seq: 3 },
    { deviceId: "d2", token: "t2", platform: "android", strategyId: 1, seq: 3 },
    { deviceId: "d3", token: "t3", platform: "android", strategyId: 2, seq: 0 },
    { deviceId: "d4", token: "t4", platform: "android", strategyId: 2, seq: 0 },
  ];
  const finished: [string, string][] = [];
  const removed: string[] = [];
  const store = {
    pendingPushes: async () => pending,
    finishPush: async (push: PendingPush, status: "sent" | "failed") => void finished.push([push.deviceId, status]),
    removePushDevice: async (deviceId: string) => void removed.push(deviceId),
    withWorkerLock: async (work: () => Promise<void>) => (await work(), true),
  };
  const outcomes: Record<string, PushOutcome | "throw"> = { t1: "sent", t2: "unregistered", t3: "failed", t4: "throw" };
  const refs: string[] = [];
  const delivery = new PushDelivery(store, {
    send: async ({ token, ref }) => {
      refs.push(ref);
      const outcome = outcomes[token]!;
      if (outcome === "throw") throw new Error("down");
      return outcome;
    },
  });
  await delivery.runOnce();
  assert.deepEqual(finished, [["d1", "sent"], ["d3", "failed"]]);
  assert.deepEqual(removed, ["d2"]);
  // The reference differs per device for the same strategy, and the app can recompute it.
  assert.equal(refs[0], pushRef("d1", 1));
  assert.notEqual(refs[0], refs[1]);
  assert.match(refs[0]!, /^[0-9a-f]{32}$/);
  // Shared with the app's strategyForPushRef test.
  assert.equal(pushRef("6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f", 7), "7b02db34df72e3ec1deb9beaf3cbe044");
});
