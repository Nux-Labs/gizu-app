import type { Pool } from "pg";
import type { OperationCoordinationStore } from "../../ports/operation-coordination.port.ts";
export class PgOperationCoordination implements OperationCoordinationStore {
  private schemaReady?: Promise<void>;
  constructor(private pool: Pick<Pool, "query">) {}
  private ready() {
    return (this.schemaReady ??= this.pool
      .query(
        `select pg_advisory_xact_lock(73149002); create table if not exists earn_operation_coordination (
    opaque_key text primary key check(opaque_key ~ '^[0-9a-f]{64}$'),
    commitment text not null check(commitment ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  ); create index if not exists earn_operation_coordination_expiry on earn_operation_coordination(expires_at)`,
      )
      .then(() => {})
      .catch((error) => {
        this.schemaReady = undefined;
        throw error;
      }));
  }
  async bind(
    key: string,
    commitment: string,
    expires: number,
    exclusive: boolean,
  ) {
    await this.ready();
    const result = await this.pool.query(
      `insert into earn_operation_coordination(opaque_key,commitment,expires_at)
      select $1,$2,to_timestamp($3::double precision/1000) where to_timestamp($3::double precision/1000)>now()
      on conflict(opaque_key) do update set commitment=excluded.commitment,
        expires_at=greatest(earn_operation_coordination.expires_at,excluded.expires_at)
      where earn_operation_coordination.expires_at<=now()
        or (not $4::boolean and earn_operation_coordination.commitment=excluded.commitment)
      returning opaque_key`,
      [key, commitment, expires, exclusive],
    );
    return result.rowCount === 1;
  }
  async bindMany(
    bindings: Array<{
      opaqueKey: string;
      commitments: string[];
      expiresAtMs: number;
    }>,
  ) {
    await this.ready();
    if (
      !bindings.length ||
      bindings.length > 4096 ||
      new Set(bindings.map((row) => row.opaqueKey)).size !== bindings.length
    )
      throw Error("Invalid atomic coordination batch");
    try {
      // One SQL statement is one transaction. A conflicting row violates the existing
      // commitment constraint, rolling back EVERY insert/update from this statement.
      // Preserve an exact legacy commitment instead of migrating or overwriting it.
      const result = await this.pool.query(
        `with requested as (
        select * from jsonb_to_recordset($1::jsonb) as r(opaque_key text, commitments text[], expires_at_ms double precision)
      ) insert into earn_operation_coordination(opaque_key,commitment,expires_at)
        select opaque_key,commitments[1],to_timestamp(expires_at_ms/1000) from requested
        where (select bool_and(to_timestamp(expires_at_ms/1000)>now()) from requested) order by opaque_key
        on conflict(opaque_key) do update set commitment=case
          when earn_operation_coordination.expires_at<=now() then excluded.commitment
          when earn_operation_coordination.commitment=any((select commitments from requested where opaque_key=excluded.opaque_key)::text[])
            then earn_operation_coordination.commitment
          else 'coordination-conflict' end,
          expires_at=greatest(earn_operation_coordination.expires_at,excluded.expires_at)
        returning opaque_key`,
        [
          JSON.stringify(
            bindings.map((row) => ({
              opaque_key: row.opaqueKey,
              commitments: row.commitments,
              expires_at_ms: row.expiresAtMs,
            })),
          ),
        ],
      );
      return result.rowCount === bindings.length;
    } catch (error) {
      if ((error as { code?: string }).code === "23514") return false;
      throw error;
    }
  }
  async purgeExpired() {
    await this.ready();
    await this.pool.query(
      "delete from earn_operation_coordination where expires_at<=now()",
    );
  }
}
