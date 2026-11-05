import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import type { RecoveryUploadAdmission } from "../../ports/recovery-upload-admission.port.ts";
export const recoveryAdmissionDefaults = {
  callsPerMinute: 1024,
  bytesPerMinute: 64 * 1024 * 1024,
  bytesPerDay: 512 * 1024 * 1024,
  maxClients: 16384,
};
/** Fixed-cardinality expiring buckets. IP text never reaches PostgreSQL. */
export class PgRecoveryUploadAdmission implements RecoveryUploadAdmission {
  private schemaReady?: Promise<void>;
  private key?: Buffer;
  constructor(
    private pool: Pick<Pool, "query" | "connect">,
    keyHex?: string,
    private limits = recoveryAdmissionDefaults,
  ) {
    if (keyHex && /^[0-9a-f]{64}$/i.test(keyHex))
      this.key = Buffer.from(keyHex, "hex");
  }
  private ready() {
    return (this.schemaReady ??= this.pool
      .query(
        `select pg_advisory_xact_lock(73149003);
    create table if not exists wallet_recovery_upload_admission (
      client_commitment text primary key check(client_commitment ~ '^[0-9a-f]{64}$'),
      minute_at timestamptz not null,
      minute_calls integer not null,
      minute_bytes bigint not null,
      daily_bytes bigint not null,
      expires_at timestamptz not null
    ); create index if not exists wallet_recovery_admission_expiry on wallet_recovery_upload_admission(expires_at)`,
      )
      .then(() => {})
      .catch((error) => {
        this.schemaReady = undefined;
        throw error;
      }));
  }
  async admit(clientIp: string, decodedBytes: number): Promise<boolean> {
    if (!this.key || !Number.isSafeInteger(decodedBytes) || decodedBytes < 0)
      throw new Error("Recovery admission unavailable");
    const commitment = createHmac("sha256", this.key)
      .update("gizu-wallet-recovery-upload-ip:v1\0")
      .update(clientIp)
      .digest("hex");
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // Serializes row admission as well as updates, enforcing the hard bucket cap.
      await client.query("select pg_advisory_xact_lock(73149004)");
      await client.query(
        "delete from wallet_recovery_upload_admission where expires_at<=now()",
      );
      const current = await client.query<{
        minute_calls: number;
        minute_bytes: string;
        daily_bytes: string;
        fresh: boolean;
      }>(
        `select
        minute_calls,minute_bytes,daily_bytes,minute_at=date_trunc('minute',now()) as fresh
        from wallet_recovery_upload_admission where client_commitment=$1 for update`,
        [commitment],
      );
      const row = current.rows[0];
      if (!row) {
        const count = await client.query<{ count: string }>(
          "select count(*)::text as count from wallet_recovery_upload_admission",
        );
        if (Number(count.rows[0]!.count) >= this.limits.maxClients) {
          await client.query("commit");
          return false;
        }
      }
      const calls = (row?.fresh ? row.minute_calls : 0) + 1;
      const minuteBytes =
        (row?.fresh ? BigInt(row.minute_bytes) : 0n) + BigInt(decodedBytes);
      const dailyBytes = BigInt(row?.daily_bytes ?? 0) + BigInt(decodedBytes);
      if (
        calls > this.limits.callsPerMinute ||
        minuteBytes > BigInt(this.limits.bytesPerMinute) ||
        dailyBytes > BigInt(this.limits.bytesPerDay)
      ) {
        await client.query("commit");
        return false;
      }
      await client.query(
        `insert into wallet_recovery_upload_admission(client_commitment,minute_at,minute_calls,minute_bytes,daily_bytes,expires_at)
        values($1,date_trunc('minute',now()),$2,$3,$4,now()+interval '24 hours')
        on conflict(client_commitment) do update set minute_at=excluded.minute_at,minute_calls=excluded.minute_calls,
          minute_bytes=excluded.minute_bytes,daily_bytes=excluded.daily_bytes`,
        [commitment, calls, minuteBytes.toString(), dailyBytes.toString()],
      );
      await client.query("commit");
      return true;
    } catch {
      await client.query("rollback").catch(() => {});
      throw new Error("Recovery admission unavailable");
    } finally {
      client.release();
    }
  }
  async purgeExpired() {
    await this.ready();
    await this.pool.query(
      "delete from wallet_recovery_upload_admission where expires_at<=now()",
    );
  }
}
