import type {
  FeedEvent,
  SocialSession,
  StrategyCard,
  StrategyComment,
  StrategyHistoryEntry,
  StrategySocialService,
} from "@/domain/strategies";
import type { StrategySocialDeps } from "@/features/strategies/useStrategySocial";
import { ApiError } from "@/services/http";
import {
  createMemorySocialSessionStore,
  type StoredSocialSession,
} from "@/services/socialSessionStore";

/** Social and pricing fields a card has when nobody has liked, commented or repriced it. */
export const quietCard: Pick<
  StrategyCard,
  "social" | "latestAssets" | "priceVersion" | "priceChangeAllowedAt" | "liked"
> = {
  social: { likes: 0, comments: 0 },
  latestAssets: [],
  priceVersion: 0,
  priceChangeAllowedAt: null,
  liked: false,
};

export function historyEntry(
  overrides: Partial<StrategyHistoryEntry> & Pick<StrategyHistoryEntry, "seq" | "assets">,
): StrategyHistoryEntry {
  return {
    committedAt: null,
    revealedAt: null,
    commitTx: null,
    revealTx: null,
    periodReturnBps: null,
    likes: 0,
    comments: 0,
    liked: false,
    ...overrides,
  };
}

export const SOCIAL_TOKEN = `0x${"7".repeat(64)}`;
export const SOCIAL_ACCOUNT = "0x00000000000000000000000000000000000050c1";
const SOCIAL_SIGNATURE = `0x${"ab".repeat(64)}1c`;

/**
 * An in-memory social API: comments with one reply level, likes per target and a fixed feed.
 * Sessions are checked like the real API: writes without the issued token fail with 401.
 */
export function fakeSocial(
  options: { feed?: FeedEvent[]; nickname?: string; ownerName?: string } = {},
) {
  let nextId = 1;
  let ownerOf: number | null = null;
  const comments: (StrategyComment & { strategyId: number; author: string })[] = [];
  const likes = new Map<string, Set<string>>();
  const target = (strategyId: number, seq: number | null) => `${strategyId}:${seq ?? "profile"}`;
  const authed = (token: string) => {
    if (token !== SOCIAL_TOKEN) throw new ApiError(401, "UNAUTHORIZED", "x");
    return SOCIAL_ACCOUNT;
  };
  const view = (comment: (typeof comments)[number], viewer: string | null): StrategyComment => ({
    id: comment.id,
    seq: comment.seq,
    parentId: comment.parentId,
    body: comment.body,
    createdAt: comment.createdAt,
    authorName: comment.authorName,
    owner: comment.owner,
    mine: viewer === comment.author,
    replies: comments
      .filter((reply) => reply.parentId === comment.id)
      .map((reply) => view(reply, viewer)),
  });
  const service = {
    challenge: jest.fn(async () => ({ nonce: `0x${"5".repeat(64)}`, issuedAt: 1_900_000_000 })),
    createSession: jest.fn(
      async (request: Parameters<StrategySocialService["createSession"]>[0]) => {
        ownerOf = request.ownerLink?.strategyId ?? null;
        return {
          token: SOCIAL_TOKEN,
          expiresAt: "2099-01-01T00:00:00.000Z",
          name: options.nickname ?? "Calm Otter #50c1",
          ownerOf,
        } satisfies SocialSession;
      },
    ),
    like: jest.fn(async (token: string, strategyId: number, seq: number | null) => {
      const set = likes.get(target(strategyId, seq)) ?? new Set();
      set.add(authed(token));
      likes.set(target(strategyId, seq), set);
      return { liked: true, count: set.size };
    }),
    unlike: jest.fn(async (token: string, strategyId: number, seq: number | null) => {
      const set = likes.get(target(strategyId, seq)) ?? new Set();
      set.delete(authed(token));
      return { liked: false, count: set.size };
    }),
    comments: jest.fn(
      async (
        strategyId: number,
        seq: number | null,
        _cursor: string | null,
        token: string | null,
      ) => {
        const viewer = token === SOCIAL_TOKEN ? SOCIAL_ACCOUNT : null;
        return {
          list: comments
            .filter((c) => c.strategyId === strategyId && c.seq === seq && c.parentId === null)
            .reverse()
            .map((c) => view(c, viewer)),
          next: null,
        };
      },
    ),
    postComment: jest.fn(
      async (
        token: string,
        strategyId: number,
        comment: { body: string; seq: number | null; parentId: number | null },
      ) => {
        const author = authed(token);
        const created = {
          id: nextId++,
          strategyId,
          author,
          seq: comment.seq,
          parentId: comment.parentId,
          body: comment.body,
          createdAt: "2026-11-23T12:00:00.000Z",
          authorName:
            ownerOf === strategyId
              ? (options.ownerName ?? "AI chips")
              : (options.nickname ?? "Calm Otter #50c1"),
          owner: ownerOf === strategyId,
          mine: true,
          replies: [],
        };
        comments.push(created);
        return view(created, author);
      },
    ),
    deleteComment: jest.fn(async (token: string, id: number) => {
      authed(token);
      comments.splice(
        comments.findIndex((c) => c.id === id),
        1,
      );
    }),
    reportComment: jest.fn(async (token: string) => {
      authed(token);
    }),
    hideComment: jest.fn(async (token: string) => {
      authed(token);
    }),
    feed: jest.fn(async () => ({ list: options.feed ?? [], next: null })),
  } satisfies StrategySocialService;
  /** A comment someone else wrote, as the API would hold it. */
  const seed = (strategyId: number, seq: number | null, body: string, authorName: string) => {
    comments.push({
      id: nextId++,
      strategyId,
      author: "0xsomeoneelse",
      seq,
      parentId: null,
      body,
      createdAt: "2026-11-23T10:00:00.000Z",
      authorName,
      owner: false,
      mine: false,
      replies: [],
    });
  };
  return { service, seed };
}

export function socialSigner() {
  return {
    socialAddress: jest.fn(async () => SOCIAL_ACCOUNT),
    signIn: jest.fn(
      async (
        _walletId: string,
        _chainId: number,
        _nonce: string,
        _issuedAt: number,
        owner: number | null,
      ) => ({
        account: SOCIAL_ACCOUNT,
        signature: SOCIAL_SIGNATURE,
        ownerSignature: owner === null ? null : SOCIAL_SIGNATURE,
      }),
    ),
  };
}

export function socialDeps(
  social: StrategySocialService,
  options: {
    signer?: ReturnType<typeof socialSigner> | null;
    ownStrategyId?: number | null;
    session?: StoredSocialSession;
    nowMs?: number;
  } = {},
): StrategySocialDeps {
  const signer = options.signer === undefined ? socialSigner() : options.signer;
  return {
    social,
    sessions: createMemorySocialSessionStore(options.session),
    signer: () => signer,
    ownStrategyId: async () => options.ownStrategyId ?? null,
    now: () => options.nowMs ?? Date.parse("2026-11-23T12:00:00Z"),
  };
}
