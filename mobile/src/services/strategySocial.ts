import type {
  FeedEvent,
  Page,
  SealedAssetView,
  SocialSession,
  StrategyComment,
  StrategySocialService,
} from "@/domain/strategies";
import { sendJson } from "./http";
import { isSealedAsset, strategyApiBase } from "./strategies";

const UNAVAILABLE = "Comments and likes are unavailable right now. Please try again.";
const INVALID = "Invalid social response.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isAtoms = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
const isNullableInt = (value: unknown) => value === null || isInt(value);
const bearer = (token: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

function parseComment(value: unknown, depth = 0): StrategyComment {
  if (
    !isRecord(value) ||
    !isInt(value.id) ||
    !isNullableInt(value.seq) ||
    !isNullableInt(value.parentId) ||
    typeof value.body !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.authorName !== "string" ||
    typeof value.owner !== "boolean" ||
    typeof value.mine !== "boolean"
  )
    throw new Error(INVALID);
  const replies = Array.isArray(value.replies) && depth === 0 ? value.replies : [];
  return {
    id: value.id,
    seq: value.seq as number | null,
    parentId: value.parentId as number | null,
    body: value.body,
    createdAt: value.createdAt,
    authorName: value.authorName,
    owner: value.owner,
    mine: value.mine,
    replies: replies.map((reply) => parseComment(reply, depth + 1)),
  };
}

function assets(value: unknown): SealedAssetView[] {
  if (!Array.isArray(value) || !value.every(isSealedAsset)) throw new Error(INVALID);
  return value;
}

/** Feed events this app does not know yet are skipped, so a newer API never breaks the feed. */
function parseEvent(value: unknown): FeedEvent | null {
  if (
    !isRecord(value) ||
    !isInt(value.strategyId) ||
    typeof value.strategyName !== "string" ||
    typeof value.at !== "string"
  )
    throw new Error(INVALID);
  const base = { strategyId: value.strategyId, strategyName: value.strategyName, at: value.at };
  if (value.kind === "sealed" && isInt(value.seq))
    return { kind: "sealed", ...base, seq: value.seq };
  if (value.kind === "revealed" && isInt(value.seq))
    return {
      kind: "revealed",
      ...base,
      seq: value.seq,
      assets: assets(value.assets),
      previousAssets: value.previousAssets === null ? null : assets(value.previousAssets),
      periodReturnBps: isInt(value.periodReturnBps) ? value.periodReturnBps : null,
      likes: isInt(value.likes) ? value.likes : 0,
      comments: isInt(value.comments) ? value.comments : 0,
      liked: value.liked === true,
    };
  if (
    value.kind === "price" &&
    isInt(value.version) &&
    isAtoms(value.monthlyPriceAtoms) &&
    isAtoms(value.signalPriceAtoms) &&
    isRecord(value.previous) &&
    isAtoms(value.previous.monthlyPriceAtoms) &&
    isAtoms(value.previous.signalPriceAtoms)
  )
    return {
      kind: "price",
      ...base,
      version: value.version,
      monthlyPriceAtoms: value.monthlyPriceAtoms,
      signalPriceAtoms: value.signalPriceAtoms,
      previous: {
        monthlyPriceAtoms: value.previous.monthlyPriceAtoms,
        signalPriceAtoms: value.previous.signalPriceAtoms,
      },
    };
  return null;
}

function page<T>(body: unknown, parse: (value: unknown) => T | null): Page<T> {
  if (!isRecord(body) || !Array.isArray(body.list)) throw new Error(INVALID);
  if (!(body.next === null || typeof body.next === "string")) throw new Error(INVALID);
  return {
    list: body.list.map(parse).filter((item): item is T => item !== null),
    next: body.next,
  };
}

function likeResult(body: unknown) {
  if (!isRecord(body) || typeof body.liked !== "boolean" || !isInt(body.count))
    throw new Error(INVALID);
  return { liked: body.liked, count: body.count };
}

export function createStrategySocialService(baseUrl: string): StrategySocialService {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (path: string) => {
    if (!base) throw new Error("Comments and likes are not configured in this build.");
    return `${base}${path}`;
  };
  const send = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    token: string | null,
    signal?: AbortSignal,
  ) =>
    sendJson(method, url(path), body, {
      ...(signal ? { signal } : {}),
      headers: bearer(token),
      unavailable: UNAVAILABLE,
    });
  const seqQuery = (seq: number | null) => (seq === null ? "" : `seq=${seq}`);
  const query = (...parts: string[]) => {
    const used = parts.filter(Boolean);
    return used.length > 0 ? `?${used.join("&")}` : "";
  };
  const cursorQuery = (cursor: string | null) =>
    cursor === null ? "" : `cursor=${encodeURIComponent(cursor)}`;

  return {
    async challenge() {
      const body = await send("POST", "/v1/social/challenge", undefined, null);
      if (!isRecord(body) || typeof body.nonce !== "string" || !isInt(body.issuedAt))
        throw new Error(INVALID);
      if (!/^0x[0-9a-fA-F]{64}$/.test(body.nonce)) throw new Error(INVALID);
      return { nonce: body.nonce, issuedAt: body.issuedAt };
    },
    async createSession(request) {
      const body = await send("POST", "/v1/social/sessions", request, null);
      if (
        !isRecord(body) ||
        typeof body.token !== "string" ||
        typeof body.expiresAt !== "string" ||
        typeof body.name !== "string" ||
        !isNullableInt(body.ownerOf)
      )
        throw new Error(INVALID);
      return {
        token: body.token,
        expiresAt: body.expiresAt,
        name: body.name,
        ownerOf: body.ownerOf as number | null,
      } satisfies SocialSession;
    },
    async like(token, strategyId, seq) {
      return likeResult(
        await send("PUT", `/v1/strategies/${strategyId}/likes`, seq === null ? {} : { seq }, token),
      );
    },
    async unlike(token, strategyId, seq) {
      return likeResult(
        await send(
          "DELETE",
          `/v1/strategies/${strategyId}/likes${query(seqQuery(seq))}`,
          undefined,
          token,
        ),
      );
    },
    async comments(strategyId, seq, cursor, token, signal) {
      const body = await send(
        "GET",
        `/v1/strategies/${strategyId}/comments${query(seqQuery(seq), cursorQuery(cursor))}`,
        undefined,
        token,
        signal,
      );
      return page(body, (value) => parseComment(value));
    },
    async postComment(token, strategyId, comment) {
      return parseComment(
        await send(
          "POST",
          `/v1/strategies/${strategyId}/comments`,
          {
            body: comment.body,
            ...(comment.seq === null ? {} : { seq: comment.seq }),
            ...(comment.parentId === null ? {} : { parentId: comment.parentId }),
          },
          token,
        ),
      );
    },
    async deleteComment(token, id) {
      await send("DELETE", `/v1/comments/${id}`, undefined, token);
    },
    async reportComment(token, id) {
      await send("POST", `/v1/comments/${id}/report`, {}, token);
    },
    async hideComment(token, id) {
      await send("POST", `/v1/comments/${id}/hide`, {}, token);
    },
    async feed(strategyIds, cursor, token, signal) {
      const ids = strategyIds === null ? "" : `strategies=${strategyIds.join(",")}`;
      // Following nothing yet means an empty feed, not every strategy.
      if (strategyIds !== null && strategyIds.length === 0) return { list: [], next: null };
      const body = await send(
        "GET",
        `/v1/feed${query(ids, cursorQuery(cursor))}`,
        undefined,
        token,
        signal,
      );
      return page(body, parseEvent);
    },
  };
}

export const strategySocialService = createStrategySocialService(strategyApiBase);
