import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import type { AssetPrices, SealedStrategyAsset, StrategyMetadata } from "../../domain/strategy.ts";
import type {
  PendingPush,
  StrategyCommitInsert,
  StrategyCommitRecord,
  StrategyCommitStatus,
  StrategyPriceEdge,
  StrategyPriceSnapshot,
  StrategyRecord,
  StrategyStore,
} from "../../ports/strategies.port.ts";

/** Arbitrary constant identifying the strategy worker's session-level advisory lock. */
const WORKER_LOCK_KEY = 4_611_686_018_427_387_146n;
/** A relay claim older than this is assumed abandoned (a send waits at most a minute). */
const STALE_CLAIM_MINUTES = 5;

type Row = Record<string, unknown>;

export class PgStrategies implements StrategyStore {
  private schemaReady: Promise<void> | undefined;

  /**
   * `connections` provides dedicated clients for the worker lock and for transactions; tests that
   * pass a single client may omit it.
   */
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly connections?: Pick<Pool, "connect">,
  ) {}

  async saveStrategy(strategy: StrategyRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into strategies (id, signer, embargo_seconds, metadata, metadata_hash, create_tx, created_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       on conflict do nothing`,
      [
        strategy.id,
        strategy.signer.toLowerCase(),
        strategy.embargoSeconds,
        JSON.stringify(strategy.metadata),
        strategy.metadataHash,
        strategy.createTx,
        strategy.createdAt,
      ],
    );
  }

  async strategy(id: number): Promise<StrategyRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query("select * from strategies where id = $1", [id]);
    return rows[0] ? strategyRow(rows[0]) : null;
  }

  async strategyBySigner(signer: Address): Promise<StrategyRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query("select * from strategies where signer = $1", [
      signer.toLowerCase(),
    ]);
    return rows[0] ? strategyRow(rows[0]) : null;
  }

  async listStrategies(filter?: { signers?: readonly Address[] }): Promise<StrategyRecord[]> {
    await this.ensureSchema();
    const { rows } = filter?.signers
      ? await this.pool.query("select * from strategies where signer = any($1) order by id", [
          filter.signers.map((signer) => signer.toLowerCase()),
        ])
      : await this.pool.query("select * from strategies order by id");
    return rows.map(strategyRow);
  }

  async commits(strategyIds: readonly number[]): Promise<StrategyCommitRecord[]> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return [];
    const { rows } = await this.pool.query(
      "select * from strategy_commits where strategy_id = any($1) order by strategy_id, seq",
      [strategyIds],
    );
    return rows.map(commitRow);
  }

  async addPendingCommit(commit: StrategyCommitInsert): Promise<boolean> {
    await this.ensureSchema();
    // A failed commitment never reached the registry, so its sequence number is free again.
    const { rowCount } = await this.pool.query(
      `insert into strategy_commits
         (strategy_id, seq, commitment, basket, salt, signature, deadline, status, relay_after)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, 'pending', $8)
       on conflict (strategy_id, seq) do update set
         commitment = excluded.commitment, basket = excluded.basket, salt = excluded.salt,
         signature = excluded.signature, deadline = excluded.deadline, status = 'pending',
         relay_after = excluded.relay_after, claimed_at = null, commit_tx = null, committed_at = null
       where strategy_commits.status = 'failed'`,
      [
        commit.strategyId,
        commit.seq,
        commit.commitment,
        JSON.stringify(commit.basket),
        commit.salt,
        commit.signature,
        commit.deadline,
        commit.relayAfter,
      ],
    );
    return rowCount === 1;
  }

  async dueRelays(now: Date, limit: number): Promise<StrategyCommitRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `select * from strategy_commits
       where (status = 'pending' and relay_after <= $1)
          or (status = 'relaying'
              and claimed_at < $1::timestamptz - interval '${STALE_CLAIM_MINUTES} minutes')
       order by relay_after limit $2`,
      [now, limit],
    );
    return rows.map(commitRow);
  }

  async claimRelay(strategyId: number, seq: number, now: Date): Promise<boolean> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query(
      `update strategy_commits set status = 'relaying', claimed_at = $3
       where strategy_id = $1 and seq = $2
         and (status = 'pending'
              or (status = 'relaying'
                  and claimed_at < $3::timestamptz - interval '${STALE_CLAIM_MINUTES} minutes'))`,
      [strategyId, seq, now],
    );
    return rowCount === 1;
  }

  async releaseRelay(strategyId: number, seq: number): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `update strategy_commits set status = 'pending', claimed_at = null
       where strategy_id = $1 and seq = $2 and status = 'relaying'`,
      [strategyId, seq],
    );
  }

  async markCommitted(
    strategyId: number,
    seq: number,
    tx: Hex | null,
    committedAt: Date,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      // The chain is the source of truth: a reconciliation may correct a row marked failed.
      `update strategy_commits set status = 'committed', commit_tx = coalesce($3, commit_tx),
         committed_at = $4
       where strategy_id = $1 and seq = $2 and status in ('pending', 'relaying', 'failed')`,
      [strategyId, seq, tx, committedAt],
    );
  }

  async markFailed(strategyId: number, seq: number): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `update strategy_commits set status = 'failed'
       where strategy_id = $1 and seq = $2 and status in ('pending', 'relaying')`,
      [strategyId, seq],
    );
  }

  async dueReveals(now: Date, limit: number): Promise<StrategyCommitRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `select c.* from strategy_commits c join strategies s on s.id = c.strategy_id
       where c.status = 'committed'
         and c.seq = (select min(x.seq) from strategy_commits x
                      where x.strategy_id = c.strategy_id and x.status = 'committed')
         and c.committed_at + make_interval(secs => s.embargo_seconds) <= $1
       order by c.committed_at limit $2`,
      [now, limit],
    );
    return rows.map(commitRow);
  }

  async markRevealed(
    strategyId: number,
    seq: number,
    tx: Hex | null,
    revealedAt: Date,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `update strategy_commits set status = 'revealed', reveal_tx = $3, revealed_at = $4
       where strategy_id = $1 and seq = $2 and status = 'committed'`,
      [strategyId, seq, tx, revealedAt],
    );
  }

  async saveSnapshot(snapshot: StrategyPriceSnapshot): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into strategy_price_snapshots (strategy_id, seq, edge, prices, taken_at)
       values ($1, $2, $3, $4::jsonb, $5) on conflict do nothing`,
      [snapshot.strategyId, snapshot.seq, snapshot.edge, JSON.stringify(snapshot.prices), snapshot.takenAt],
    );
  }

  async snapshots(strategyIds: readonly number[]): Promise<StrategyPriceSnapshot[]> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return [];
    const { rows } = await this.pool.query(
      "select * from strategy_price_snapshots where strategy_id = any($1)",
      [strategyIds],
    );
    return rows.map((row: Row) => ({
      strategyId: Number(row.strategy_id),
      seq: Number(row.seq),
      edge: row.edge as StrategyPriceEdge,
      prices: row.prices as AssetPrices,
      takenAt: row.taken_at as Date,
    }));
  }

  async addTrialSubscription(strategyId: number, keyHash: Hex, expiresAt: Date): Promise<boolean> {
    await this.ensureSchema();
    // The row lock serializes sign-ups. The count must be a separate statement: under READ
    // COMMITTED, a statement sees only rows committed before it started, so a count inside the
    // locking statement would miss a sign-up that committed while it waited for the lock.
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        "select (metadata->>'seats')::int as seats from strategies where id = $1 for update",
        [strategyId],
      );
      if (!rows[0]) return false;
      const taken = await client.query(
        `select count(*)::int as taken from strategy_subscriptions
         where strategy_id = $1 and expires_at > now()`,
        [strategyId],
      );
      if (taken.rows[0].taken >= rows[0].seats) return false;
      const { rowCount } = await client.query(
        `insert into strategy_subscriptions (strategy_id, key_hash, kind, expires_at)
         values ($1, $2, 'trial', $3) on conflict do nothing`,
        [strategyId, keyHash, expiresAt],
      );
      return rowCount === 1;
    });
  }

  /** Runs `work` in one transaction on a dedicated client, or on the single test client. */
  private async transaction<T>(work: (client: Pick<Pool, "query">) => Promise<T>): Promise<T> {
    if (!this.connections) return work(this.pool);
    const client = await this.connections.connect();
    let failure: Error | undefined;
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch((rollback: Error) => {
        failure = rollback;
      });
      throw error;
    } finally {
      client.release(failure);
    }
  }

  async hasSubscription(strategyId: number, keyHash: Hex, now: Date): Promise<boolean> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `select 1 from strategy_subscriptions
       where strategy_id = $1 and key_hash = $2 and expires_at > $3`,
      [strategyId, keyHash, now],
    );
    return rows.length > 0;
  }

  async seatsTaken(strategyIds: readonly number[], now: Date): Promise<Map<number, number>> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `select strategy_id, count(*) as taken from strategy_subscriptions
       where strategy_id = any($1) and expires_at > $2 group by strategy_id`,
      [strategyIds, now],
    );
    return new Map(rows.map((row: Row) => [Number(row.strategy_id), Number(row.taken)]));
  }

  async earnedAtoms(strategyIds: readonly number[]): Promise<Map<number, bigint>> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `select strategy_id, sum(amount_atoms)::text as earned from strategy_payments
       where strategy_id = any($1) group by strategy_id`,
      [strategyIds],
    );
    return new Map(rows.map((row: Row) => [Number(row.strategy_id), BigInt(String(row.earned))]));
  }

  async recordPayment(payment: {
    strategyId: number;
    kind: "x402";
    amountAtoms: string;
    reference: string;
  }): Promise<boolean> {
    await this.ensureSchema();
    // The settlement transaction is the reference; a replayed receipt is never booked twice.
    const { rowCount } = await this.pool.query(
      `insert into strategy_payments (strategy_id, kind, amount_atoms, reference)
       values ($1, $2, $3, $4) on conflict (reference) do nothing`,
      [payment.strategyId, payment.kind, payment.amountAtoms, payment.reference.toLowerCase()],
    );
    return rowCount === 1;
  }

  async registerPushDevice(token: string, platform: "android" | "ios"): Promise<string> {
    await this.ensureSchema();
    // A known token gets a new device: returning the old id would hand it to anyone holding the
    // token. Its follows and queued notifications go with the old device.
    await this.pool.query("delete from push_devices where token = $1", [token]);
    const id = randomUUID();
    await this.pool.query("insert into push_devices (id, token, platform) values ($1, $2, $3)", [
      id,
      token,
      platform,
    ]);
    return id;
  }

  async pendingPushes(limit: number): Promise<PendingPush[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `select * from (
         select distinct on (o.device_id, o.strategy_id)
                o.device_id, d.token, d.platform, o.strategy_id, o.seq, o.created_at
           from push_outbox o join push_devices d on d.id = o.device_id
          where o.status = 'pending'
          order by o.device_id, o.strategy_id, o.seq desc
       ) newest
       order by created_at
       limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      deviceId: String(row.device_id),
      token: String(row.token),
      platform: row.platform as "android" | "ios",
      strategyId: Number(row.strategy_id),
      seq: Number(row.seq),
    }));
  }

  async finishPush(push: PendingPush, status: "sent" | "failed"): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `update push_outbox set status = $4
        where device_id = $1 and strategy_id = $2 and seq <= $3 and status = 'pending'`,
      [push.deviceId, push.strategyId, push.seq, status],
    );
  }

  async followWithDevice(deviceId: string, strategyId: number): Promise<boolean> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query(
      `insert into push_follows (device_id, strategy_id)
       select d.id, s.id from push_devices d, strategies s where d.id = $1 and s.id = $2
       on conflict do nothing`,
      [deviceId, strategyId],
    );
    if (rowCount === 1) return true;
    const { rows } = await this.pool.query(
      "select 1 from push_follows where device_id = $1 and strategy_id = $2",
      [deviceId, strategyId],
    );
    return rows.length > 0;
  }

  async removePushDevice(deviceId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("delete from push_devices where id = $1", [deviceId]);
  }

  async queueStrategyPush(strategyId: number, seq: number): Promise<number> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query(
      `insert into push_outbox (device_id, strategy_id, seq)
       select device_id, strategy_id, $2 from push_follows where strategy_id = $1
       on conflict do nothing`,
      [strategyId, seq],
    );
    return rowCount ?? 0;
  }

  async withWorkerLock(work: () => Promise<void>): Promise<boolean> {
    await this.ensureSchema();
    if (!this.connections) {
      await work();
      return true;
    }
    const client = await this.connections.connect();
    // The pool stops listening for errors on a checked-out client, and the lock client idles for
    // the whole pass; an unhandled 'error' from a dropped connection would crash the process.
    let broken: Error | undefined;
    const onError = (error: Error) => {
      broken = error;
    };
    client.on("error", onError);
    try {
      const { rows } = await client.query("select pg_try_advisory_lock($1) as locked", [
        WORKER_LOCK_KEY.toString(),
      ]);
      if (rows[0]?.locked !== true) return false;
      try {
        await work();
      } finally {
        await client
          .query("select pg_advisory_unlock($1)", [WORKER_LOCK_KEY.toString()])
          .catch((error: Error) => {
            broken = error;
          });
      }
      return true;
    } finally {
      client.off("error", onError);
      // A client that may still hold the lock is destroyed rather than returned to the pool.
      client.release(broken);
    }
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool
        .query(`
          create table if not exists strategies (
            id bigint primary key,
            signer text not null unique,
            embargo_seconds integer not null check (embargo_seconds > 0),
            metadata jsonb not null,
            metadata_hash text not null,
            create_tx text,
            created_at timestamptz not null default now()
          );
          create table if not exists strategy_commits (
            strategy_id bigint not null references strategies(id),
            seq integer not null check (seq >= 0),
            commitment text not null,
            basket jsonb not null,
            salt text not null,
            signature text not null,
            deadline bigint not null,
            status text not null
              check (status in ('pending', 'relaying', 'committed', 'revealed', 'failed')),
            relay_after timestamptz not null,
            claimed_at timestamptz,
            commit_tx text,
            committed_at timestamptz,
            reveal_tx text,
            revealed_at timestamptz,
            primary key (strategy_id, seq)
          );
          create index if not exists strategy_commits_status on strategy_commits (status, relay_after);
          create table if not exists strategy_price_snapshots (
            strategy_id bigint not null references strategies(id),
            seq integer not null,
            edge text not null check (edge in ('start', 'end')),
            prices jsonb not null,
            taken_at timestamptz not null,
            primary key (strategy_id, seq, edge)
          );
          create table if not exists strategy_subscriptions (
            strategy_id bigint not null references strategies(id),
            key_hash text not null,
            kind text not null check (kind in ('trial', 'paid')),
            created_at timestamptz not null default now(),
            expires_at timestamptz not null,
            primary key (strategy_id, key_hash)
          );
          create table if not exists strategy_payments (
            id bigserial primary key,
            strategy_id bigint not null references strategies(id),
            kind text not null,
            amount_atoms numeric(78, 0) not null check (amount_atoms >= 0),
            reference text unique,
            created_at timestamptz not null default now()
          );
          create table if not exists push_devices (
            id uuid primary key,
            token text not null unique,
            platform text not null check (platform in ('android', 'ios')),
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          );
          create table if not exists push_follows (
            device_id uuid not null references push_devices(id) on delete cascade,
            strategy_id bigint not null references strategies(id),
            primary key (device_id, strategy_id)
          );
          create table if not exists push_outbox (
            id bigserial primary key,
            device_id uuid not null references push_devices(id) on delete cascade,
            strategy_id bigint not null references strategies(id),
            seq integer not null,
            status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
            created_at timestamptz not null default now(),
            unique (device_id, strategy_id, seq)
          );
        `)
        .then(() => {})
        .catch((error: unknown) => {
          this.schemaReady = undefined;
          throw error;
        });
    }
    return this.schemaReady;
  }
}

function strategyRow(row: Row): StrategyRecord {
  return {
    id: Number(row.id),
    signer: getAddress(String(row.signer)),
    embargoSeconds: Number(row.embargo_seconds),
    metadata: row.metadata as StrategyMetadata,
    metadataHash: row.metadata_hash as Hex,
    createTx: (row.create_tx as Hex | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

function commitRow(row: Row): StrategyCommitRecord {
  return {
    strategyId: Number(row.strategy_id),
    seq: Number(row.seq),
    commitment: row.commitment as Hex,
    basket: row.basket as SealedStrategyAsset[],
    salt: row.salt as Hex,
    signature: row.signature as Hex,
    deadline: Number(row.deadline),
    status: row.status as StrategyCommitStatus,
    relayAfter: row.relay_after as Date,
    commitTx: (row.commit_tx as Hex | null) ?? null,
    committedAt: (row.committed_at as Date | null) ?? null,
    revealTx: (row.reveal_tx as Hex | null) ?? null,
    revealedAt: (row.revealed_at as Date | null) ?? null,
  };
}
