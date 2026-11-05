import type { Pool } from "pg";
import type {
  RecoverySnapshot,
  RecoveryWrite,
  WalletRecoveryStore,
} from "../../ports/wallet-recovery.port.ts";
/** Client ciphertext only. No encryption key, wallet addresses or user catalogue. */
export class PgWalletRecovery implements WalletRecoveryStore {
  private schemaReady?: Promise<void>;
  private limits: {
    maxObjects: number;
    maxCiphertextBytes: number;
    globalMaxObjects: number;
    globalMaxCiphertextBytes: number;
  };
  constructor(
    private pool: Pick<Pool, "connect" | "query">,
    limits: Partial<PgWalletRecovery["limits"]> = {},
  ) {
    this.limits = {
      maxObjects: 4096,
      maxCiphertextBytes: 128 * 1024 * 1024,
      globalMaxObjects: 1000000,
      globalMaxCiphertextBytes: 16 * 1024 * 1024 * 1024,
      ...limits,
    };
  }
  private ready() {
    return (this.schemaReady ??= this.pool
      .query(
        `
      select pg_advisory_xact_lock(73149001);
      select pg_advisory_xact_lock(73149005);
      create table if not exists wallet_recovery_objects (
        opaque_id text primary key check (opaque_id ~ '^[0-9a-f]{64}$'),
        auth_digest text not null check (auth_digest ~ '^[0-9a-f]{64}$'),
        revision integer not null check (revision > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists wallet_recovery_auth on wallet_recovery_objects(auth_digest);
      create table if not exists wallet_recovery_versions (
        opaque_id text not null references wallet_recovery_objects(opaque_id) on delete cascade,
        revision integer not null check (revision > 0),
        ciphertext text not null check (octet_length(ciphertext) <= 1398102),
        created_at timestamptz not null default now(),
        primary key (opaque_id, revision)
      );
      create table if not exists wallet_recovery_capacity (
        singleton integer primary key check(singleton=1),
        objects bigint not null check(objects>=0),bytes bigint not null check(bytes>=0)
      );
      insert into wallet_recovery_capacity(singleton,objects,bytes)
        select 1,count(distinct o.opaque_id),coalesce(sum(floor(length(v.ciphertext)::numeric*3/4)),0)::bigint
        from wallet_recovery_objects o join wallet_recovery_versions v using(opaque_id)
        on conflict(singleton) do nothing`,
      )
      .then(() => {})
      .catch((error) => {
        this.schemaReady = undefined;
        throw error;
      }));
  }
  async remove(id: string, authDigest: string): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(73149005)");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,73150))",
        [authDigest],
      );
      const removed = await client.query<{ objects: string; bytes: string }>(
        `select count(distinct o.opaque_id)::text as objects,
        coalesce(sum(floor(length(v.ciphertext)::numeric*3/4)),0)::text as bytes
        from wallet_recovery_objects o join wallet_recovery_versions v using(opaque_id) where o.opaque_id=$1 and o.auth_digest=$2`,
        [id, authDigest],
      );
      await client.query(
        "delete from wallet_recovery_objects where opaque_id=$1 and auth_digest=$2",
        [id, authDigest],
      );
      await client.query(
        "update wallet_recovery_capacity set objects=objects-$1::bigint,bytes=bytes-$2::bigint where singleton=1",
        [removed.rows[0]!.objects, removed.rows[0]!.bytes],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async read(id: string, authDigest: string): Promise<RecoverySnapshot | null> {
    await this.ready();
    const result = await this.pool.query<{
      revision: number;
      ciphertext: string;
    }>(
      `
      select v.revision, v.ciphertext from wallet_recovery_objects o
      join wallet_recovery_versions v on v.opaque_id=o.opaque_id and v.revision=o.revision
      where o.opaque_id=$1 and o.auth_digest=$2`,
      [id, authDigest],
    );
    const row = result.rows[0];
    return row ? { version: 1, ...row } : null;
  }
  async write(
    id: string,
    authDigest: string,
    expectedRevision: number,
    ciphertext: string,
  ): Promise<RecoveryWrite> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(73149005)");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,73150))",
        [authDigest],
      );
      // Serializes creation as well as updates. Hash collisions only serialize unrelated objects.
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 73149))",
        [id],
      );
      const current = await client.query<{
        auth_digest: string;
        revision: number;
      }>(
        "select auth_digest,revision from wallet_recovery_objects where opaque_id=$1 for update",
        [id],
      );
      const row = current.rows[0];
      if (
        (row && row.auth_digest !== authDigest) ||
        (!row && expectedRevision !== 0)
      ) {
        await client.query("rollback");
        return { status: "missing" };
      }
      if ((row?.revision ?? 0) !== expectedRevision) {
        await client.query("rollback");
        return { status: "conflict" };
      }
      const priorBytes = await client.query<{ bytes: string }>(
        "select coalesce(sum(floor(length(ciphertext)::numeric*3/4)),0)::text as bytes from wallet_recovery_versions where opaque_id=$1",
        [id],
      );
      const revision = expectedRevision + 1;
      await client.query(
        `insert into wallet_recovery_objects(opaque_id,auth_digest,revision) values($1,$2,$3)
        on conflict(opaque_id) do update set revision=excluded.revision,updated_at=now()`,
        [id, authDigest, revision],
      );
      await client.query(
        "insert into wallet_recovery_versions(opaque_id,revision,ciphertext) values($1,$2,$3)",
        [id, revision, ciphertext],
      );
      await client.query(
        "delete from wallet_recovery_versions where opaque_id=$1 and revision <= $2",
        [id, revision - 3],
      );
      const usage = await client.query<{ objects: string; bytes: string }>(
        `select count(distinct o.opaque_id)::text as objects,
        coalesce(sum(floor(length(v.ciphertext)::numeric*3/4)),0)::text as bytes
        from wallet_recovery_objects o join wallet_recovery_versions v using(opaque_id) where o.auth_digest=$1`,
        [authDigest],
      );
      if (
        BigInt(usage.rows[0]!.objects) > BigInt(this.limits.maxObjects) ||
        BigInt(usage.rows[0]!.bytes) > BigInt(this.limits.maxCiphertextBytes)
      ) {
        await client.query("rollback");
        return { status: "quota" };
      }
      const retainedBytes = await client.query<{ bytes: string }>(
        "select coalesce(sum(floor(length(ciphertext)::numeric*3/4)),0)::text as bytes from wallet_recovery_versions where opaque_id=$1",
        [id],
      );
      const deltaBytes =
        BigInt(retainedBytes.rows[0]!.bytes) -
        BigInt(priorBytes.rows[0]!.bytes);
      const capacity = await client.query(
        `update wallet_recovery_capacity set objects=objects+$1::bigint,bytes=bytes+$2::bigint
        where singleton=1 and objects+$1::bigint <= $3::bigint and bytes+$2::bigint <= $4::bigint returning singleton`,
        [
          row ? 0 : 1,
          deltaBytes.toString(),
          this.limits.globalMaxObjects,
          this.limits.globalMaxCiphertextBytes,
        ],
      );
      if (capacity.rowCount !== 1) {
        await client.query("rollback");
        return { status: "quota" };
      }
      await client.query("commit");
      return { status: "ok", snapshot: { version: 1, revision, ciphertext } };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
