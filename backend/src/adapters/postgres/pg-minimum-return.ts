import type { Pool } from "pg";
import type {
  MinimumReturnReceipt,
  MinimumReturnStore,
} from "../../ports/minimum-return.port.ts";
const columns =
  'account_key as "accountKey",route_key as "routeKey",commitment,observation_sequence as sequence,minimum_atoms as "minimumAtoms",observed_at_ms as "observedAtMs"';
function decode(row: Record<string, unknown>): MinimumReturnReceipt {
  return {
    accountKey: String(row.accountKey),
    routeKey: String(row.routeKey),
    commitment: String(row.commitment),
    sequence: String(row.sequence),
    minimumAtoms: String(row.minimumAtoms),
    observedAtMs: Number(row.observedAtMs),
  };
}
/** Permanent exclusion ledger. Only keyed digests and minimal evidence metadata
 * are stored; snapshots and signatures remain in the native encrypted journal. */
export class PgMinimumReturnStore implements MinimumReturnStore {
  private schemaReady?: Promise<void>;
  constructor(private pool: Pick<Pool, "query" | "connect">) {}
  private ready() {
    return (this.schemaReady ??= this.pool
      .query(
        `select pg_advisory_xact_lock(73149003);
      create table if not exists earn_minimum_return_sequences (
        account_key text primary key check(account_key ~ '^[0-9a-f]{64}$'),
        observation_sequence numeric(78,0) not null check(observation_sequence>=0)
      );
      create table if not exists earn_minimum_return_receipts (
        route_key text primary key check(route_key ~ '^[0-9a-f]{64}$'),
        account_key text not null references earn_minimum_return_sequences(account_key),
        commitment text not null check(commitment ~ '^[0-9a-f]{64}$'),
        observation_sequence numeric(78,0) not null check(observation_sequence>=0),
        minimum_atoms numeric(78,0) not null check(minimum_atoms>0),
        observed_at_ms bigint not null check(observed_at_ms>=0),
        unique(account_key,observation_sequence)
      )`,
      )
      .then(() => {})
      .catch((error) => {
        this.schemaReady = undefined;
        throw error;
      }));
  }
  async sequence(key: string) {
    await this.ready();
    const result = await this.pool.query(
      "select observation_sequence from earn_minimum_return_sequences where account_key=$1",
      [key],
    );
    return result.rows[0] ? String(result.rows[0].observation_sequence) : "0";
  }
  async receipt(key: string) {
    await this.ready();
    const result = await this.pool.query(
      `select ${columns} from earn_minimum_return_receipts where route_key=$1`,
      [key],
    );
    return result.rows[0] ? decode(result.rows[0]) : undefined;
  }
  async finish(value: MinimumReturnReceipt) {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into earn_minimum_return_sequences(account_key,observation_sequence) values($1,0) on conflict do nothing",
        [value.accountKey],
      );
      const sequence = await client.query(
        "select observation_sequence from earn_minimum_return_sequences where account_key=$1 for update",
        [value.accountKey],
      );
      const previous = await client.query(
        `select ${columns} from earn_minimum_return_receipts where route_key=$1`,
        [value.routeKey],
      );
      if (previous.rows[0]) {
        const saved = decode(previous.rows[0]);
        await client.query("rollback");
        return saved.accountKey === value.accountKey &&
          saved.commitment === value.commitment &&
          saved.minimumAtoms === value.minimumAtoms
          ? saved
          : undefined;
      }
      if (String(sequence.rows[0]?.observation_sequence) !== value.sequence) {
        await client.query("rollback");
        return undefined;
      }
      const inserted = await client.query(
        `insert into earn_minimum_return_receipts(account_key,route_key,commitment,observation_sequence,minimum_atoms,observed_at_ms)
        values($1,$2,$3,$4,$5,$6) on conflict(route_key) do nothing returning ${columns}`,
        [
          value.accountKey,
          value.routeKey,
          value.commitment,
          value.sequence,
          value.minimumAtoms,
          value.observedAtMs,
        ],
      );
      if (!inserted.rows[0]) {
        await client.query("rollback");
        return undefined;
      }
      await client.query(
        "update earn_minimum_return_sequences set observation_sequence=observation_sequence+1 where account_key=$1",
        [value.accountKey],
      );
      await client.query("commit");
      return decode(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
