import type { Address, Hex } from "viem";

/** A signed-in social key. `account` is never returned by the API. */
export type SocialSession = {
  account: Address;
  /** The strategy whose key co-signed the sign-in, if any. */
  ownerOf: number | null;
  expiresAt: Date;
};

/** A strategy (`seq` null) or one of its revealed updates. */
export type SocialTarget = { strategyId: number; seq: number | null };

export type SocialCount = SocialTarget & { likes: number; comments: number };

export type CommentRecord = {
  id: number;
  strategyId: number;
  seq: number | null;
  parentId: number | null;
  account: Address;
  /** The author's session owned the strategy when posting. */
  owner: boolean;
  body: string;
  createdAt: Date;
  deletedAt: Date | null;
  hiddenAt: Date | null;
};

export type CommentInsert = Pick<
  CommentRecord,
  "strategyId" | "seq" | "parentId" | "account" | "owner" | "body"
>;

export interface SocialStore {
  addChallenge(nonce: Hex, issuedAt: number, expiresAt: Date): Promise<void>;
  /** Marks an unexpired, unused challenge as used; false when it is unknown, used or expired. */
  consumeChallenge(nonce: Hex, issuedAt: number, now: Date): Promise<boolean>;
  /** Stores a session under the sha256 of its token; the token itself is never stored. */
  addSession(tokenHash: Hex, session: SocialSession): Promise<void>;
  session(tokenHash: Hex, now: Date): Promise<SocialSession | null>;
  /** Idempotently sets or clears one like and returns the target's like count afterwards. */
  setLike(account: Address, target: SocialTarget, liked: boolean): Promise<number>;
  /** Like and visible-comment counts per target; targets without any may be omitted. */
  counts(strategyIds: readonly number[]): Promise<SocialCount[]>;
  likedTargets(account: Address, strategyIds: readonly number[]): Promise<SocialTarget[]>;
  /**
   * Inserts a comment unless the account already posted `perMinute` comments in the last minute or
   * `perDay` in the last day (deleted ones included); then returns "rate-limited".
   */
  addComment(
    comment: CommentInsert,
    now: Date,
    limits: { perMinute: number; perDay: number },
  ): Promise<CommentRecord | "rate-limited">;
  comment(id: number): Promise<CommentRecord | null>;
  /** Visible top-level comments of a target, newest first, with ids below `beforeId`. */
  topLevelComments(target: SocialTarget, beforeId: number | null, limit: number): Promise<CommentRecord[]>;
  /** Visible replies to the given comments, oldest first, at most `perParent` per comment. */
  replies(parentIds: readonly number[], perParent: number): Promise<CommentRecord[]>;
  /** Soft delete; the row stays for rate limits. */
  deleteComment(id: number, now: Date): Promise<void>;
  /** Records one report per account; hides the comment once `hideAt` distinct accounts reported it. */
  reportComment(id: number, account: Address, reason: string | null, hideAt: number, now: Date): Promise<void>;
  hideComment(id: number, now: Date): Promise<void>;
}
