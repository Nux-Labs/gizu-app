import { DomainError } from "../../domain/errors/domain-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import { StatusDomainError } from "../../domain/errors/status-error.ts";
import {
  COMMENT_LIMIT_PER_DAY,
  COMMENT_LIMIT_PER_MINUTE,
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_REPLIES,
  COMMENT_REPORTS_TO_HIDE,
  socialNickname,
} from "../../domain/social.ts";
import type { CommentRecord, SocialSession, SocialStore, SocialTarget } from "../../ports/social.port.ts";
import type { StrategyRecord, StrategyStore } from "../../ports/strategies.port.ts";
import { decodeCursor, encodeCursor, invalidCursor } from "../cursor.ts";

/** A comment as the API shows it: never the author's account, only a nickname or the owner flag. */
export type CommentView = {
  id: number;
  seq: number | null;
  parentId: number | null;
  body: string;
  createdAt: string;
  authorName: string;
  owner: boolean;
  mine: boolean;
  replies: CommentView[];
};

export type CommentPage = { list: CommentView[]; next: string | null };

/**
 * Likes and comments on a strategy (its profile wall) and on its revealed updates. Sealed
 * updates are never a target, so nothing here hints at an embargoed basket.
 */
export class StrategySocial {
  constructor(
    private readonly social: SocialStore,
    private readonly strategies: Pick<StrategyStore, "strategy" | "commits">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async like(
    session: SocialSession,
    strategyId: number,
    seq: number | undefined,
    liked: boolean,
  ): Promise<{ liked: boolean; count: number }> {
    const target = await this.target(strategyId, seq);
    const count = await this.social.setLike(session.account, target.target, liked);
    return { liked, count };
  }

  async comments(
    strategyId: number,
    query: { seq?: number; cursor?: string; limit: number },
    viewer: SocialSession | null,
  ): Promise<CommentPage> {
    const { strategy, target } = await this.target(strategyId, query.seq);
    let beforeId: number | null = null;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (!Number.isSafeInteger(decoded) || (decoded as number) <= 0) throw invalidCursor();
      beforeId = decoded as number;
    }
    const rows = await this.social.topLevelComments(target, beforeId, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const replies = await this.social.replies(page.map((c) => c.id), COMMENT_MAX_REPLIES);
    return {
      list: page.map((comment) => ({
        ...view(comment, strategy, viewer),
        replies: replies.filter((r) => r.parentId === comment.id).map((r) => view(r, strategy, viewer)),
      })),
      next: rows.length > query.limit ? encodeCursor(page.at(-1)!.id) : null,
    };
  }

  async post(
    session: SocialSession,
    strategyId: number,
    input: { body: string; seq?: number; parentId?: number },
  ): Promise<CommentView> {
    const body = input.body.trim();
    if (body.length < 1 || body.length > COMMENT_MAX_LENGTH)
      throw new DomainError("COMMENT_INVALID", "A comment has 1 to 500 characters.");
    const { strategy, target } = await this.target(strategyId, input.seq);
    if (input.parentId !== undefined) {
      const parent = await this.social.comment(input.parentId);
      if (
        !parent ||
        parent.strategyId !== strategyId ||
        parent.seq !== target.seq ||
        parent.parentId !== null ||
        parent.deletedAt ||
        parent.hiddenAt
      )
        throw new DomainError("COMMENT_PARENT_INVALID", "Replies go to a top-level comment of the same thread.");
    }
    const saved = await this.social.addComment(
      {
        strategyId,
        seq: target.seq,
        parentId: input.parentId ?? null,
        account: session.account,
        owner: session.ownerOf === strategyId,
        body,
      },
      this.now(),
      { perMinute: COMMENT_LIMIT_PER_MINUTE, perDay: COMMENT_LIMIT_PER_DAY },
    );
    if (saved === "rate-limited")
      throw new StatusDomainError(429, "SOCIAL_RATE_LIMITED", "Too many comments; please try again later.");
    return view(saved, strategy, session);
  }

  async remove(session: SocialSession, id: number): Promise<void> {
    const comment = await this.existing(id, true);
    if (comment.account !== session.account)
      throw new StatusDomainError(403, "SOCIAL_FORBIDDEN", "Only the author can delete a comment.");
    await this.social.deleteComment(id, this.now());
  }

  async report(session: SocialSession, id: number, reason: string | undefined): Promise<void> {
    await this.existing(id);
    const trimmed = reason?.trim();
    await this.social.reportComment(id, session.account, trimmed ? trimmed : null, COMMENT_REPORTS_TO_HIDE, this.now());
  }

  async hide(session: SocialSession, id: number): Promise<void> {
    const comment = await this.existing(id);
    if (session.ownerOf !== comment.strategyId)
      throw new StatusDomainError(403, "SOCIAL_FORBIDDEN", "Only the strategy owner can hide a comment.");
    await this.social.hideComment(id, this.now());
  }

  /** A strategy, or one of its revealed updates when `seq` is given; 404 otherwise. */
  private async target(
    strategyId: number,
    seq: number | undefined,
  ): Promise<{ strategy: StrategyRecord; target: SocialTarget }> {
    const strategy = await this.strategies.strategy(strategyId);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(strategyId));
    if (seq === undefined) return { strategy, target: { strategyId, seq: null } };
    const revealed = (await this.strategies.commits([strategyId])).some(
      (c) => c.seq === seq && c.status === "revealed",
    );
    if (!revealed) throw new NotFoundError({ name: "Revealed update" }, `${strategyId}/${seq}`);
    return { strategy, target: { strategyId, seq } };
  }

  private async existing(id: number, includeDeleted = false): Promise<CommentRecord> {
    const comment = await this.social.comment(id);
    if (!comment || (comment.deletedAt && !includeDeleted)) throw new NotFoundError({ name: "Comment" }, String(id));
    return comment;
  }
}

function view(comment: CommentRecord, strategy: StrategyRecord, viewer: SocialSession | null): CommentView {
  return {
    id: comment.id,
    seq: comment.seq,
    parentId: comment.parentId,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    authorName: comment.owner ? strategy.metadata.name : socialNickname(comment.account),
    owner: comment.owner,
    mine: !!viewer && viewer.account === comment.account,
    replies: [],
  };
}
