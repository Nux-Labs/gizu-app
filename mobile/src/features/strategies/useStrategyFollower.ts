import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  StrategyCard,
  StrategyDetail,
  StrategyService,
  StrategySignal,
} from "@/domain/strategies";
import { ApiError } from "@/services/http";
import { strategyErrorMessage, strategyService } from "@/services/strategies";
import {
  secureFollowStore,
  type FollowedStrategy,
  type StrategyFollowStore,
} from "@/services/strategyFollows";
import {
  enableStrategyPush,
  followStrategyPush,
  nativePushPlatform,
  strategyPushApi,
  type PushPlatform,
  type PushResult,
  type StrategyPushApi,
} from "@/services/strategyPush";
import { getStoredSwapSigner, type StoredSwapBridge } from "@/services/wallet/nativeBridge";

export type SwapRunner = Pick<StoredSwapBridge, "startSwap" | "getSwapStatus">;

export type StrategyFollowerDeps = {
  service: StrategyService;
  follows: StrategyFollowStore;
  push: { api: StrategyPushApi; platform: PushPlatform };
  swap: () => SwapRunner | null;
  now: () => number;
};
const defaultDeps: StrategyFollowerDeps = {
  service: strategyService,
  follows: secureFollowStore,
  push: { api: strategyPushApi, platform: nativePushPlatform },
  swap: getStoredSwapSigner,
  now: Date.now,
};

/** Tests and previews provide their own API, storage, notifications and swap engine. */
export const StrategyFollowerContext = createContext<StrategyFollowerDeps>(defaultDeps);

export function useStrategyFollowerDeps() {
  return useContext(StrategyFollowerContext);
}

const pushMessages: Record<Exclude<PushResult, "enabled">, string> = {
  denied: "Notifications are off for Gizu. Turn them on in Settings to hear about updates.",
  unavailable: "Update notifications aren't available in this build. Check back here for updates.",
};

/** Every strategy card, and which ones this phone follows. */
export function useStrategyList() {
  const { service, follows } = useStrategyFollowerDeps();
  const [cards, setCards] = useState<StrategyCard[]>([]);
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([service.list(), follows.load()])
      .then(([list, mine]) => {
        if (!active) return;
        setCards(list);
        setFollowed(new Set(mine.map((follow) => follow.strategyId)));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(strategyErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [follows, revision, service]);
  const reload = useCallback(() => {
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);
  return { cards, followed, loading, error, reload };
}

/**
 * One strategy as a follower sees it: its public record, this phone's trial and the newest basket
 * the trial unlocks. The subscriber key stays in the keystore and only travels to the API.
 */
export function useStrategyFollower(strategyId: number, token: string | null = null) {
  const deps = useStrategyFollowerDeps();
  const { service, follows, now } = deps;
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [follow, setFollow] = useState<FollowedStrategy | null>(null);
  const [signal, setSignal] = useState<StrategySignal | null>(null);
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pushNotice, setPushNotice] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      service.detail(strategyId, undefined, token),
      follows.load(),
      follows.pushDevice(),
    ])
      .then(async ([card, mine, device]) => {
        const mineHere = mine.find((entry) => entry.strategyId === strategyId) ?? null;
        let basket: StrategySignal | null = null;
        let ended = false;
        if (mineHere) {
          try {
            basket = await service.signal(strategyId, mineHere.subscriberKey);
          } catch (cause) {
            if (!(cause instanceof ApiError && cause.code === "PAYMENT_REQUIRED")) throw cause;
            ended = true;
          }
        }
        if (!active) return;
        setDetail(card);
        setFollow(mineHere);
        setSignal(basket);
        setExpired(ended);
        setPushOn(device !== null);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(strategyErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [follows, revision, service, strategyId, token]);

  const reload = useCallback(() => {
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);

  const operate = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setOperationError(null);
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setOperationError(strategyErrorMessage(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  /** Takes a trial seat, keeps its key on the phone and asks for update notifications. */
  const subscribe = useCallback(
    () =>
      operate(async () => {
        if (!detail) return;
        const trial = await service.subscribe(strategyId);
        const mine = (await follows.load()).filter((entry) => entry.strategyId !== strategyId);
        const added: FollowedStrategy = {
          strategyId,
          name: detail.name,
          subscriberKey: trial.subscriberKey,
          expiresAt: trial.expiresAt,
          copiedSeq: null,
        };
        await follows.save([...mine, added]);
        // Notifications are a convenience: a failure here never undoes the trial.
        const result = await followStrategyPush({ ...deps.push, store: follows }, strategyId).catch(
          (): PushResult => "unavailable",
        );
        if (mounted.current) {
          setPushNotice(result === "enabled" ? null : pushMessages[result]);
          setPushOn(result === "enabled");
        }
        reload();
      }),
    [deps.push, detail, follows, operate, reload, service, strategyId],
  );

  const enableNotifications = useCallback(
    () =>
      operate(async () => {
        const ids = (await follows.load()).map((entry) => entry.strategyId);
        const result = await enableStrategyPush({ ...deps.push, store: follows }, ids, true);
        if (mounted.current) {
          setPushNotice(
            result === "enabled" ? "Update notifications are on." : pushMessages[result],
          );
          setPushOn(result === "enabled");
        }
      }),
    [deps.push, follows, operate],
  );

  /** Remembers the basket the phone copied, so a later update shows how far behind it is. */
  const markCopied = useCallback(
    async (seq: number) => {
      const mine = await follows.load();
      await follows.save(
        mine.map((entry) =>
          entry.strategyId === strategyId ? { ...entry, copiedSeq: seq } : entry,
        ),
      );
      if (mounted.current)
        setFollow((current) => (current ? { ...current, copiedSeq: seq } : current));
    },
    [follows, strategyId],
  );

  const unfollow = useCallback(
    () =>
      operate(async () => {
        const mine = await follows.load();
        await follows.save(mine.filter((entry) => entry.strategyId !== strategyId));
        reload();
      }),
    [follows, operate, reload, strategyId],
  );

  return {
    detail,
    follow,
    signal,
    expired,
    loading,
    loadError,
    operationError,
    pushNotice,
    pushOn,
    busy,
    now,
    reload,
    subscribe,
    enableNotifications,
    markCopied,
    unfollow,
  };
}
