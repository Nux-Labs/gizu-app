import { createSign } from "node:crypto";
import type { PushOutcome, PushSender } from "../../ports/strategies.port.ts";

/** The fields of a Firebase service account key file this sender uses. */
export type FcmServiceAccount = { project_id: string; client_email: string; private_key: string };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Android channel the app creates for strategy updates. */
export const STRATEGY_PUSH_CHANNEL = "strategy-updates";

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/**
 * FCM HTTP v1 sender. The notification is neutral: no strategy name, weights or id, only an
 * opaque per-device reference the app maps back. Updates to one strategy replace each other on
 * the device (same collapse key and tag).
 */
export class FcmPushSender implements PushSender {
  private access?: { token: string; expiresAt: number };

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(message: { token: string; platform: "android" | "ios"; ref: string }): Promise<PushOutcome> {
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: {
              title: "Strategy update",
              body: "A strategy you follow has a new basket.",
            },
            data: { type: "strategy-update", ref: message.ref },
            android: {
              priority: "high",
              collapse_key: message.ref,
              notification: { tag: message.ref, channel_id: STRATEGY_PUSH_CHANNEL },
            },
            apns: { headers: { "apns-collapse-id": message.ref } },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.ok) return "sent";
    if (response.status === 401) this.access = undefined;
    const body = (await response.json().catch(() => null)) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    } | null;
    const code = body?.error?.details?.find((detail) => detail.errorCode)?.errorCode;
    // Only FCM's explicit code removes a device; a bare 404 may be a misconfigured project.
    if (code === "UNREGISTERED") return "unregistered";
    // Rate limits, outages and auth problems are retried; anything else is this message's fault.
    if (response.status === 429 || response.status === 401 || response.status >= 500)
      throw new Error(`FCM unavailable (${response.status})`);
    return "failed";
  }

  /** OAuth access token from a self-signed service account JWT, reused until shortly before expiry. */
  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.access && this.access.expiresAt > now + 60_000) return this.access.token;
    const issuedAt = Math.floor(now / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    )}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.account.private_key);
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64url(signature)}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`FCM auth failed (${response.status})`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new Error("FCM auth failed");
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.access = { token: body.access_token, expiresAt: now + lifetime * 1000 };
    return body.access_token;
  }
}
