import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
/** Portable server-authenticated ciphertext. Configure one durable server-only key;
 * process-local random keys cannot recover an encrypted native journal after restart. */
export class EarnRecoveryEnvelope {
  private key?: Buffer;
  constructor(keyHex?: string) {
    if (keyHex !== undefined) {
      if (!/^[0-9a-f]{64}$/i.test(keyHex))
        throw new Error("Invalid Earn recovery key");
      this.key = Buffer.from(keyHex, "hex");
    }
  }
  get configured() {
    return this.key !== undefined;
  }
  seal(
    purpose:
      | "private-payout"
      | "confidential-cashout"
      | "confidential-private-funding"
      | "native-quote"
      | "fusion-order"
      | "private-balance"
      | "source-credit",
    value: unknown,
  ): string {
    if (!this.key) throw new Error("Earn recovery key unavailable");
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 131072) throw new Error("Earn recovery body too large");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`gizu-earn-recovery:v1:${purpose}`));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    bytes.fill(0);
    return [
      "v1",
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }
  open(
    purpose:
      | "private-payout"
      | "confidential-cashout"
      | "confidential-private-funding"
      | "native-quote"
      | "fusion-order"
      | "private-balance"
      | "source-credit",
    token: string,
  ): unknown {
    if (!this.key || token.length > 180000)
      throw new Error("Invalid Earn recovery envelope");
    const parts = token.split(".");
    if (
      parts.length !== 4 ||
      parts[0] !== "v1" ||
      parts.slice(1).some((v) => !/^[A-Za-z0-9_-]+$/.test(v))
    )
      throw new Error("Invalid Earn recovery envelope");
    const [nonce, tag, encrypted] = parts
      .slice(1)
      .map((v) => Buffer.from(v, "base64url"));
    if (
      nonce!.length !== 12 ||
      tag!.length !== 16 ||
      encrypted!.length > 131072 ||
      parts
        .slice(1)
        .some((v, i) => [nonce, tag, encrypted][i]!.toString("base64url") !== v)
    )
      throw new Error("Invalid Earn recovery envelope");
    const cipher = createDecipheriv("aes-256-gcm", this.key, nonce!);
    cipher.setAAD(Buffer.from(`gizu-earn-recovery:v1:${purpose}`));
    cipher.setAuthTag(tag!);
    const bytes = Buffer.concat([cipher.update(encrypted!), cipher.final()]);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } finally {
      bytes.fill(0);
    }
  }
}
