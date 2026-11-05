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
  async purgeExpired() {
    await this.ready();
    await this.pool.query(
      "delete from earn_operation_coordination where expires_at<=now()",
    );
  }
}
