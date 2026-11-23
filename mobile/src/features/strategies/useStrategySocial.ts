import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  STRATEGY_REGISTRY_CHAIN,
  type FeedEvent,
  type SocialSession,
  type StrategyComment,
  type StrategyService,
  type StrategySocialService,
} from "@/domain/strategies";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { ApiError } from "@/services/http";
import { secureSocialSessionStore, type SocialSessionStore } from "@/services/socialSessionStore";
import { strategyErrorMessage, strategyService } from "@/services/strategies";
import { strategySocialService } from "@/services/strategySocial";
import { getStoredSocialSigner, getStoredStrategySigner } from "@/services/wallet/nativeBridge";
import { STRATEGY_KEY_INDEX } from "./useStrategyOwner";

type SocialSigner = NonNullable<ReturnType<typeof getStoredSocialSigner>>;

export type StrategySocialDeps = {
  social: StrategySocialService;
  sessions: SocialSessionStore;
  signer: () => SocialSigner | null;
  /** This wallet's strategy id, so its owner comments as the strategy; null without one. */
  ownStrategyId: (walletId: string) => Promise<number | null>;
  now: () => number;
};

async function findOwnStrategy(
  walletId: string,
  service: StrategyService = strategyService,
): Promise<number | null> {
  const signer = getStoredStrategySigner();
  if (!signer) return null;
  const [address] = await signer.strategyAddresses(
    walletId,
    STRATEGY_REGISTRY_CHAIN,
    STRATEGY_KEY_INDEX,
    1,
  );
  if (!address) return null;
  const [card] = await service.list([address]);
  return card?.id ?? null;
}

const defaultDeps: StrategySocialDeps = {
  social: strategySocialService,
  sessions: secureSocialSessionStore,
  signer: getStoredSocialSigner,
  ownStrategyId: (walletId) => findOwnStrategy(walletId),
  now: Date.now,
};

/** Tests and previews provide their own API, keystore and signer. */
export const StrategySocialContext = createContext<StrategySocialDeps>(defaultDeps);

export function useStrategySocialDeps() {
  return useContext(StrategySocialContext);
}

// Every screen reads the same session; a sign-in or sign-out on one tells the others.
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());

const unauthorized = (cause: unknown) => cause instanceof ApiError && cause.status === 401;

/**
 * The viewer's social session. Signing in takes one passkey approval: the social key signs the
 * API's challenge, and a strategy owner's strategy key also signs that it speaks for the strategy.
 */
export function useSocialSession() {
  const deps = useStrategySocialDeps();
  const walletId = useOptionalMainnetWallet()?.session.walletId ?? null;
  const [session, setSession] = useState<SocialSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<SocialSession> | null>(null);

  useEffect(() => {
    let active = true;
    const read = () => {
      if (!walletId) {
        setLoaded(true);
        return;
      }
      void deps.sessions.load(walletId).then((stored) => {
        if (!active) return;
        setSession(stored);
        setLoaded(true);
      });
    };
    read();
    listeners.add(read);
    return () => {
      active = false;
      listeners.delete(read);
    };
  }, [deps.sessions, walletId]);

  const signIn = useCallback(async (): Promise<SocialSession> => {
    if (pending.current) return pending.current;
    const signer = deps.signer();
    if (!signer || !walletId)
      throw new Error("Comments and likes need the Gizu Android app with a ready wallet.");
    const work = (async () => {
      setSigningIn(true);
      setError(null);
      try {
        const owner = await deps.ownStrategyId(walletId).catch(() => null);
        const challenge = await deps.social.challenge();
        const signed = await signer.signIn(
          walletId,
          STRATEGY_REGISTRY_CHAIN,
          challenge.nonce,
          challenge.issuedAt,
          owner,
        );
        const created = await deps.social.createSession({
          account: signed.account,
          nonce: challenge.nonce,
          issuedAt: challenge.issuedAt,
          signature: signed.signature,
          ...(owner !== null && signed.ownerSignature
            ? { ownerLink: { strategyId: owner, signature: signed.ownerSignature } }
            : {}),
        });
        await deps.sessions.save(walletId, created);
        setSession(created);
        announce();
        return created;
      } catch (cause) {
        setError(strategyErrorMessage(cause));
        throw cause;
      } finally {
        setSigningIn(false);
        pending.current = null;
      }
    })();
    pending.current = work;
    return work;
  }, [deps, walletId]);

  const signOut = useCallback(async () => {
    await deps.sessions.clear();
    setSession(null);
    announce();
  }, [deps.sessions]);

  /** Runs a write with a session, signing in first when needed and again once if it expired. */
  const withSession = useCallback(
    async <T>(work: (token: string) => Promise<T>): Promise<T> => {
      const current = session ?? (await signIn());
      try {
        return await work(current.token);
      } catch (cause) {
        if (!unauthorized(cause)) throw cause;
        await deps.sessions.clear();
        setSession(null);
        return work((await signIn()).token);
      }
    },
    [deps.sessions, session, signIn],
  );

  return {
    session,
    loaded,
    signingIn,
    error,
    available: deps.signer() !== null && walletId !== null,
    signIn,
    signOut,
    withSession,
  };
}

/** Likes on a strategy (`seq` null) or one revealed update, updated optimistically. */
export function useLike(
  strategyId: number,
  seq: number | null,
  initial: { liked: boolean; count: number },
) {
  const { social } = useStrategySocialDeps();
  const { withSession } = useSocialSession();
  const [state, setState] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refreshed parent brings newer counts; take them unless a toggle is in flight.
  if (!busy && (seen.liked !== initial.liked || seen.count !== initial.count)) {
    setSeen(initial);
    setState(initial);
  }

  const toggle = useCallback(async () => {
    if (busy) return;
    const before = state;
    const liking = !before.liked;
    setBusy(true);
    setError(null);
    setState({ liked: liking, count: Math.max(0, before.count + (liking ? 1 : -1)) });
    try {
      const result = await withSession((token) =>
        liking ? social.like(token, strategyId, seq) : social.unlike(token, strategyId, seq),
      );
      setState(result);
    } catch (cause) {
      setState(before);
      setError(strategyErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, seq, social, state, strategyId, withSession]);

  return { ...state, busy, error, toggle };
}

/** One comment thread: the profile wall (`seq` null) or a revealed update's comments. */
export function useComments(strategyId: number, seq: number | null) {
  const { social } = useStrategySocialDeps();
  const { session, loaded, withSession } = useSocialSession();
  const [list, setList] = useState<StrategyComment[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [revision, setRevision] = useState(0);
  const token = session?.token ?? null;
  // Comments removed here stay gone, even when a page fetched earlier arrives later or the API
  // still serves a comment this viewer reported.
  const removed = useRef(new Set<number>());
  const visible = (comments: StrategyComment[]) =>
    comments
      .filter((comment) => !removed.current.has(comment.id))
      .map((comment) => ({
        ...comment,
        replies: comment.replies.filter((reply) => !removed.current.has(reply.id)),
      }));

  useEffect(() => {
    // Wait for the stored session, so `mine` flags arrive with the first page.
    if (!loaded) return;
    const controller = new AbortController();
    social
      .comments(strategyId, seq, null, token, controller.signal)
      .then((page) => {
        setList(visible(page.list));
        setNext(page.next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(strategyErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loaded, revision, seq, social, strategyId, token]);

  const reload = useCallback(() => {
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);

  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true);
    try {
      const page = await social.comments(strategyId, seq, next, token);
      setList((current) => [...current, ...visible(page.list)]);
      setNext(page.next);
    } catch (cause) {
      setError(strategyErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [loading, next, seq, social, strategyId, token]);

  const act = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    setActionError(null);
    try {
      await work();
      return true;
    } catch (cause) {
      setActionError(strategyErrorMessage(cause));
      return false;
    }
  }, []);

  const post = useCallback(
    async (body: string, parentId: number | null): Promise<boolean> => {
      setPosting(true);
      try {
        return await act(async () => {
          const created = await withSession((t) =>
            social.postComment(t, strategyId, { body: body.trim(), seq, parentId }),
          );
          setList((current) =>
            parentId === null
              ? [created, ...current]
              : current.map((comment) =>
                  comment.id === parentId
                    ? { ...comment, replies: [...comment.replies, created] }
                    : comment,
                ),
          );
        });
      } finally {
        setPosting(false);
      }
    },
    [act, seq, social, strategyId, withSession],
  );

  /** Drops a comment, or a reply, from the visible thread. */
  const drop = (id: number) => {
    removed.current.add(id);
    setList((current) =>
      current
        .filter((comment) => comment.id !== id)
        .map((comment) => ({
          ...comment,
          replies: comment.replies.filter((reply) => reply.id !== id),
        })),
    );
  };

  const remove = (id: number) =>
    act(async () => {
      await withSession((t) => social.deleteComment(t, id));
      drop(id);
    });
  const report = (id: number) =>
    act(async () => {
      await withSession((t) => social.reportComment(t, id));
      drop(id);
    });
  const hide = (id: number) =>
    act(async () => {
      await withSession((t) => social.hideComment(t, id));
      drop(id);
    });

  return {
    list,
    next,
    loading,
    error,
    actionError,
    posting,
    reload,
    loadMore,
    post,
    remove,
    report,
    hide,
  };
}

/** Feed events newest first: every strategy (`null`) or only the given ones. */
export function useFeed(strategyIds: readonly number[] | null) {
  const { social } = useStrategySocialDeps();
  const { session, loaded } = useSocialSession();
  const [list, setList] = useState<FeedEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const token = session?.token ?? null;
  const ids = strategyIds === null ? null : [...strategyIds].sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    social
      .feed(
        ids === null ? null : ids ? ids.split(",").map(Number) : [],
        null,
        token,
        controller.signal,
      )
      .then((page) => {
        setList(page.list);
        setNext(page.next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(strategyErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ids, loaded, revision, social, token]);

  const reload = useCallback(() => {
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);
  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true);
    try {
      const page = await social.feed(
        ids === null ? null : ids ? ids.split(",").map(Number) : [],
        next,
        token,
      );
      setList((current) => [...current, ...page.list]);
      setNext(page.next);
    } catch (cause) {
      setError(strategyErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [ids, loading, next, social, token]);

  return { list, next, loading, error, reload, loadMore };
}
