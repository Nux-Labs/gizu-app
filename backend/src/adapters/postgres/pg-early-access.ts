import type { Pool } from "pg";
import type {
  EarlyAccess,
  EarlyAccessReader,
  EarlyAccessRecord,
  EarlyAccessSignup,
} from "../../ports/early-access.port.ts";

export class PgEarlyAccess implements EarlyAccess, EarlyAccessReader {
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly pool: Pick<Pool, "query">) {}

  async add({ email, ...preferences }: EarlyAccessSignup): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into early_access_signups (email, preferences)
       values ($1, $2::jsonb)
       on conflict (email) do update
       set preferences = early_access_signups.preferences || excluded.preferences`,
      [email.trim().toLowerCase(), JSON.stringify(preferences)],
    );
  }

  async list(): Promise<EarlyAccessRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{
      email: string;
      created_at: Date;
      platform: string | null;
      source: string | null;
      consent: boolean;
      consent_recorded_at: string | null;
    }>(
      `select email, created_at,
         preferences->>'platform' as platform,
         preferences->>'source' as source,
         coalesce((preferences->>'consent')::boolean, false) as consent,
         preferences->>'consentRecordedAt' as consent_recorded_at
       from early_access_signups
       order by created_at desc, email`,
    );
    return rows.map((row) => ({
      email: row.email,
      createdAt: row.created_at,
      platform: row.platform,
      source: row.source,
      consent: row.consent,
      consentRecordedAt: row.consent_recorded_at,
    }));
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool.query(`
        create table if not exists early_access_signups (
          email text primary key,
          preferences jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `).then(() => {}).catch((error: unknown) => {
        this.schemaReady = undefined;
        throw error;
      });
    }
    return this.schemaReady;
  }
}
