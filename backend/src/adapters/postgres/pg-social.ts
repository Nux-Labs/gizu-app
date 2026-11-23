import type { Pool } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import type {
  CommentInsert,
  CommentRecord,
  SocialCount,
  SocialSession,
  SocialStore,
  SocialTarget,
} from "../../ports/social.port.ts";

type Row = Record<string, unknown>;

/**
 * Likes, comments and social sessions. Accounts are social keys (they hold no funds and are never
 * returned); session tokens are stored as sha256 only.
 */
export class PgSocial implements SocialStore {
  private schemaReady: Promise<void> | undefined;

  /**
   * `strategies` creates the tables these reference. `connections` provides a dedicated client for
   * the rate-limited comment insert; tests that pass a single client may omit it.
   */
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly strategies: { ready(): Promise<void> },
    private readonly connections?: Pick<Pool, "connect">,
  ) {}

  async addChallenge(nonce: Hex, issuedAt: number, expiresAt: Date): Promise<void> {
    await this.ensureSchema();
    // Unused challenges are only kept until they expire.
    await this.pool.query("delete from social_challenges where expires_at < now() - interval '1 hour'");
    await this.pool.query(
      "insert into social_challenges (nonce, issued_at, expires_at) values ($1, $2, $3)",
      [nonce.toLowerCase(), issuedAt, expiresAt],
    );
  }

  async consumeChallenge(nonce: Hex, issuedAt: number, now: Date): Promise<boolean> {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query(
      `update social_challenges set used_at = $3
       where nonce = $1 and issued_at = $2 and used_at is null and expires_at > $3`,
      [nonce.toLowerCase(), issuedAt, now],
    );
    return rowCount === 1;
  }

  async addSession(tokenHash: Hex, session: SocialSession): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("delete from social_sessions where expires_at < now()");
    await this.pool.query(
      "insert into social_sessions (token_hash, account, owner_of, expires_at) values ($1, $2, $3, $4)",
      [tokenHash.toLowerCase(), session.account.toLowerCase(), session.ownerOf, session.expiresAt],
    );
  }

  async session(tokenHash: Hex, now: Date): Promise<SocialSession | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      "select * from social_sessions where token_hash = $1 and expires_at > $2",
      [tokenHash.toLowerCase(), now],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      account: getAddress(String(row.account)),
      ownerOf: row.owner_of === null ? null : Number(row.owner_of),
      expiresAt: row.expires_at as Date,
    };
  }

  async setLike(account: Address, target: SocialTarget, liked: boolean): Promise<number> {
    await this.ensureSchema();
    if (liked)
      await this.pool.query(
        `insert into social_likes (strategy_id, seq, account) values ($1, $2, $3)
         on conflict (strategy_id, (coalesce(seq, -1)), account) do nothing`,
        [target.strategyId, target.seq, account.toLowerCase()],
      );
    else
      await this.pool.query(
        `delete from social_likes
         where strategy_id = $1 and seq is not distinct from $2::int and account = $3`,
        [target.strategyId, target.seq, account.toLowerCase()],
      );
    const { rows } = await this.pool.query(
      `select count(*)::int as n from social_likes where strategy_id = $1 and seq is not distinct from $2::int`,
      [target.strategyId, target.seq],
    );
    return Number(rows[0].n);
  }

  async counts(strategyIds: readonly number[]): Promise<SocialCount[]> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return [];
    // A reply counts while it and its parent are visible, as the comment list shows it.
    const { rows } = await this.pool.query(
      `select strategy_id, seq, sum(likes)::int as likes, sum(comments)::int as comments from (
         select strategy_id, seq, count(*) as likes, 0 as comments
           from social_likes where strategy_id = any($1) group by strategy_id, seq
         union all
         select c.strategy_id, c.seq, 0, count(*)
           from social_comments c left join social_comments p on p.id = c.parent_id
          where c.strategy_id = any($1) and c.deleted_at is null and c.hidden_at is null
            and (c.parent_id is null or (p.deleted_at is null and p.hidden_at is null))
          group by c.strategy_id, c.seq
       ) t group by strategy_id, seq`,
      [strategyIds],
    );
    return rows.map((row: Row) => ({
      strategyId: Number(row.strategy_id),
      seq: row.seq === null ? null : Number(row.seq),
      likes: Number(row.likes),
      comments: Number(row.comments),
    }));
  }

  async likedTargets(account: Address, strategyIds: readonly number[]): Promise<SocialTarget[]> {
    await this.ensureSchema();
    if (strategyIds.length === 0) return [];
    const { rows } = await this.pool.query(
      "select strategy_id, seq from social_likes where account = $1 and strategy_id = any($2)",
      [account.toLowerCase(), strategyIds],
    );
    return rows.map((row: Row) => ({
      strategyId: Number(row.strategy_id),
      seq: row.seq === null ? null : Number(row.seq),
    }));
  }

  async addComment(
    comment: CommentInsert,
    now: Date,
    limits: { perMinute: number; perDay: number },
  ): Promise<CommentRecord | "rate-limited"> {
    await this.ensureSchema();
    const account = comment.account.toLowerCase();
    // The per-account lock serializes one account's posts, so concurrent requests cannot both pass
    // the count; it must precede the counting statement, whose snapshot starts with it.
    return this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 147))", [`social:${account}`]);
      const { rows } = await client.query(
        `insert into social_comments (strategy_id, seq, parent_id, account, owner, body, created_at)
         select $1::bigint, $2::int, $3::bigint, $4::text, $5::boolean, $6::text, $7::timestamptz
          where (select count(*) from social_comments
                  where account = $4 and created_at > $7::timestamptz - interval '1 minute') < $8
            and (select count(*) from social_comments
                  where account = $4 and created_at > $7::timestamptz - interval '1 day') < $9
         returning *`,
        [
          comment.strategyId,
          comment.seq,
          comment.parentId,
          account,
          comment.owner,
          comment.body,
          now,
          limits.perMinute,
          limits.perDay,
        ],
      );
      return rows[0] ? commentRow(rows[0]) : "rate-limited";
    });
  }

  async comment(id: number): Promise<CommentRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query("select * from social_comments where id = $1", [id]);
    return rows[0] ? commentRow(rows[0]) : null;
  }

  async topLevelComments(
    target: SocialTarget,
    beforeId: number | null,
    limit: number,
  ): Promise<CommentRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `select * from social_comments
       where strategy_id = $1 and seq is not distinct from $2::int and parent_id is null
         and deleted_at is null and hidden_at is null and ($3::bigint is null or id < $3)
       order by id desc limit $4`,
      [target.strategyId, target.seq, beforeId, limit],
    );
    return rows.map(commentRow);
  }

  async replies(parentIds: readonly number[], perParent: number): Promise<CommentRecord[]> {
    await this.ensureSchema();
    if (parentIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `select * from (
         select c.*, row_number() over (partition by parent_id order by id) as position
           from social_comments c
          where parent_id = any($1) and deleted_at is null and hidden_at is null
       ) r where position <= $2 order by parent_id, id`,
      [parentIds, perParent],
    );
    return rows.map(commentRow);
  }

  async deleteComment(id: number, now: Date): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "update social_comments set deleted_at = $2 where id = $1 and deleted_at is null",
      [id, now],
    );
  }

  async reportComment(
    id: number,
    account: Address,
    reason: string | null,
    hideAt: number,
    now: Date,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into social_comment_reports (comment_id, account, reason, created_at)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [id, account.toLowerCase(), reason, now],
    );
    // Recounted after every report, so concurrent reports still hide it.
    await this.pool.query(
      `update social_comments set hidden_at = $2
       where id = $1 and hidden_at is null
         and (select count(*) from social_comment_reports where comment_id = $1) >= $3`,
      [id, now, hideAt],
    );
  }

  async hideComment(id: number, now: Date): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "update social_comments set hidden_at = $2 where id = $1 and hidden_at is null",
      [id, now],
    );
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

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.strategies
        .ready()
        .then(() =>
          this.pool.query(`
            create table if not exists social_challenges (
              nonce text primary key,
              issued_at bigint not null,
              expires_at timestamptz not null,
              used_at timestamptz
            );
            create table if not exists social_sessions (
              token_hash text primary key,
              account text not null,
              owner_of bigint references strategies(id),
              created_at timestamptz not null default now(),
              expires_at timestamptz not null
            );
            create index if not exists social_sessions_expiry on social_sessions (expires_at);
            create table if not exists social_likes (
              strategy_id bigint not null references strategies(id),
              seq integer check (seq >= 0),
              account text not null,
              created_at timestamptz not null default now()
            );
            create unique index if not exists social_likes_target
              on social_likes (strategy_id, (coalesce(seq, -1)), account);
            create index if not exists social_likes_account on social_likes (account, strategy_id);
            create table if not exists social_comments (
              id bigserial primary key,
              strategy_id bigint not null references strategies(id),
              seq integer check (seq >= 0),
              parent_id bigint references social_comments(id),
              account text not null,
              owner boolean not null,
              body text not null check (char_length(body) between 1 and 500),
              created_at timestamptz not null,
              deleted_at timestamptz,
              hidden_at timestamptz
            );
            create index if not exists social_comments_target
              on social_comments (strategy_id, seq, id) where parent_id is null;
            create index if not exists social_comments_parent on social_comments (parent_id, id);
            create index if not exists social_comments_account on social_comments (account, created_at);
            create table if not exists social_comment_reports (
              comment_id bigint not null references social_comments(id),
              account text not null,
              reason text check (char_length(reason) <= 200),
              created_at timestamptz not null,
              primary key (comment_id, account)
            );
          `),
        )
        .then(() => {})
        .catch((error: unknown) => {
          this.schemaReady = undefined;
          throw error;
        });
    }
    return this.schemaReady;
  }
}

function commentRow(row: Row): CommentRecord {
  return {
    id: Number(row.id),
    strategyId: Number(row.strategy_id),
    seq: row.seq === null ? null : Number(row.seq),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    account: getAddress(String(row.account)),
    owner: row.owner === true,
    body: String(row.body),
    createdAt: row.created_at as Date,
    deletedAt: (row.deleted_at as Date | null) ?? null,
    hiddenAt: (row.hidden_at as Date | null) ?? null,
  };
}
