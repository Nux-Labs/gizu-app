import type {
  SealedAssetView,
  StrategyCard,
  StrategyCommitResult,
  StrategyDetail,
  StrategyHistoryEntry,
  StrategyPriceChange,
  StrategyService,
  StrategySignal,
} from "@/domain/strategies";
import { ApiError, sendJson } from "./http";

const UNAVAILABLE = "Strategies are unavailable right now. Please try again.";
/** Creation and updates wait for the registry to confirm on chain. */
const WRITE_TIMEOUT_MS = 60_000;

const messages: Record<string, string> = {
  STRATEGY_FULL: "Every seat of this strategy is taken.",
  STRATEGY_COMMIT_PENDING: "Your previous update is still being sealed. Try again in a minute.",
  STRATEGY_SEQ_STALE: "This strategy changed since you opened it. Refresh and try again.",
  STRATEGY_SEQ_TAKEN: "This strategy changed since you opened it. Refresh and try again.",
  STRATEGY_SIGNATURE_EXPIRED: "The approval expired before it was sent. Please try again.",
  STRATEGY_COMMIT_REJECTED: "The registry did not accept this update. Please try again.",
  STRATEGY_REGISTRY_REJECTED: "The registry did not accept this request. Please try again.",
  STRATEGY_INVALID: "This basket includes an asset strategies don't support.",
  PAYMENT_REQUIRED: "Your trial for this strategy has ended.",
  NOT_FOUND: "This strategy no longer exists.",
  STRATEGY_EXISTS: "A strategy with other terms already uses this key.",
  TOO_MANY_REQUESTS: "Too many requests. Please try again shortly.",
  PRICE_CHANGE_TOO_SOON: "The price can change once every 7 days. Try again later.",
  SOCIAL_RATE_LIMITED: "You're commenting very quickly. Wait a moment and try again.",
  UNAUTHORIZED: "Sign in again to like and comment.",
  SOCIAL_AUTH_REQUIRED: "Sign in again to like and comment.",
  SOCIAL_FORBIDDEN: "Only the strategy's owner can do that.",
  SOCIAL_SIGNATURE_INVALID: "The sign-in couldn't be checked. Please try again.",
  SOCIAL_CHALLENGE_INVALID: "The sign-in expired. Please try again.",
  SOCIAL_OWNER_LINK_INVALID: "This wallet couldn't prove it owns the strategy. Please try again.",
  COMMENT_INVALID: "Comments are 1 to 500 characters.",
  COMMENT_PARENT_INVALID: "That comment can't be replied to anymore.",
  STRATEGY_PRICE_VERSION_STALE: "The price changed since you opened it. Refresh and try again.",
  STRATEGY_PRICE_UNCHANGED: "Change at least one price.",
  STRATEGY_DEADLINE_TOO_FAR: "Your phone's clock looks off. Check the time and try again.",
  STRATEGY_SIGNATURE_INVALID: "The wallet's signature wasn't accepted. Please try again.",
};

/** A user-facing message for a failed strategy request. */
export function strategyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return (error.code && messages[error.code]) || UNAVAILABLE;
  // Network failures, timeouts and malformed responses carry technical text; say it plainly.
  if (
    !(error instanceof Error) ||
    !error.message ||
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    error.name === "AbortError"
  )
    return UNAVAILABLE;
  // Native wallet errors and this feature's own messages are written for people.
  return error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isAtoms = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isWord = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isNullableBps = (value: unknown) => value === null || isInt(value);
const isNullableString = (value: unknown) => value === null || typeof value === "string";

const count = (value: unknown) => (isInt(value) && value >= 0 ? value : 0);

/**
 * The card with social and pricing fields filled in; an API from before they existed reads as
 * no likes, no comments and the original price.
 */
function parseCard(value: unknown): StrategyCard {
  if (!isCard(value)) throw new Error("Invalid strategy response.");
  const raw = value as unknown as Record<string, unknown>;
  const social = isRecord(raw.social) ? raw.social : {};
  const latest = Array.isArray(raw.latestAssets) ? raw.latestAssets : [];
  if (!latest.every(isSealedAsset)) throw new Error("Invalid strategy response.");
  return {
    ...(value as StrategyCard),
    social: { likes: count(social.likes), comments: count(social.comments) },
    latestAssets: latest,
    priceVersion: count(raw.priceVersion),
    priceChangeAllowedAt:
      typeof raw.priceChangeAllowedAt === "string" ? raw.priceChangeAllowedAt : null,
    liked: raw.liked === true,
  };
}

function isCard(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.performance) || !isRecord(value.registry)) return false;
  const p = value.performance;
  return (
    isInt(value.id) &&
    isAddress(value.signer) &&
    typeof value.name === "string" &&
    isInt(value.embargoSeconds) &&
    isAtoms(value.monthlyPriceAtoms) &&
    isAtoms(value.signalPriceAtoms) &&
    isInt(value.seats) &&
    isInt(value.seatsTaken) &&
    isInt(value.commits) &&
    isInt(value.revealed) &&
    typeof value.broken === "boolean" &&
    isNullableString(value.lastCommitAt) &&
    isNullableBps(p.cumulativeReturnBps) &&
    isNullableBps(p.maxDrawdownBps) &&
    isInt(p.closedPeriods) &&
    typeof p.complete === "boolean" &&
    isAtoms(value.earnedAtoms) &&
    typeof value.createdAt === "string" &&
    isInt(value.registry.chainId) &&
    isAddress(value.registry.address)
  );
}

export function isSealedAsset(value: unknown): value is SealedAssetView {
  return (
    isRecord(value) &&
    isInt(value.chainId) &&
    (value.kind === 0 || value.kind === 1) &&
    isAddress(value.address) &&
    isInt(value.weightBps) &&
    isWord(value.assetId)
  );
}

function parseDetail(value: unknown): StrategyDetail {
  const card = parseCard(value);
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.history)) throw new Error("Invalid strategy response.");
  const history: StrategyHistoryEntry[] = raw.history.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isInt(entry.seq) ||
      !isNullableString(entry.committedAt) ||
      !isNullableString(entry.revealedAt) ||
      !isNullableString(entry.commitTx) ||
      !isNullableString(entry.revealTx) ||
      !Array.isArray(entry.assets) ||
      !entry.assets.every(isSealedAsset) ||
      !isNullableBps(entry.periodReturnBps)
    )
      throw new Error("Invalid strategy response.");
    return {
      ...(entry as unknown as StrategyHistoryEntry),
      likes: count(entry.likes),
      comments: count(entry.comments),
      liked: entry.liked === true,
    };
  });
  const prices = Array.isArray(raw.priceHistory) ? raw.priceHistory : [];
  const priceHistory: StrategyPriceChange[] = prices.flatMap((entry: unknown) =>
    isRecord(entry) &&
    isInt(entry.version) &&
    isAtoms(entry.monthlyPriceAtoms) &&
    isAtoms(entry.signalPriceAtoms) &&
    typeof entry.at === "string"
      ? [
          {
            version: entry.version,
            monthlyPriceAtoms: entry.monthlyPriceAtoms,
            signalPriceAtoms: entry.signalPriceAtoms,
            at: entry.at,
          },
        ]
      : [],
  );
  // An API from before price changes knows only the price the strategy was published with.
  if (priceHistory.length === 0)
    priceHistory.push({
      version: 0,
      monthlyPriceAtoms: card.monthlyPriceAtoms,
      signalPriceAtoms: card.signalPriceAtoms,
      at: card.createdAt,
    });
  return { ...card, history, priceHistory };
}

const bearer = (token: string | null | undefined): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

export function createStrategyService(baseUrl: string): StrategyService {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (path: string) => {
    if (!base) throw new Error("Strategies are not configured in this build.");
    return `${base}${path}`;
  };
  return {
    async list(signers, signal, token) {
      const query = signers && signers.length > 0 ? `?signers=${signers.join(",")}` : "";
      const body = await sendJson("GET", url(`/v1/strategies${query}`), undefined, {
        ...(signal ? { signal } : {}),
        headers: bearer(token),
        unavailable: UNAVAILABLE,
      });
      if (!isRecord(body) || !Array.isArray(body.list))
        throw new Error("Invalid strategy response.");
      return body.list.map(parseCard);
    },
    async detail(id, signal, token) {
      return parseDetail(
        await sendJson("GET", url(`/v1/strategies/${id}`), undefined, {
          ...(signal ? { signal } : {}),
          headers: bearer(token),
          unavailable: UNAVAILABLE,
        }),
      );
    },
    async changePrice(id, request) {
      return parseDetail(
        await sendJson("POST", url(`/v1/strategies/${id}/prices`), request, {
          unavailable: UNAVAILABLE,
        }),
      );
    },
    async create(request) {
      return parseDetail(
        await sendJson("POST", url("/v1/strategies"), request, {
          timeoutMs: WRITE_TIMEOUT_MS,
          unavailable: UNAVAILABLE,
        }),
      );
    },
    async commit(id, request) {
      const body = await sendJson("POST", url(`/v1/strategies/${id}/commits`), request, {
        timeoutMs: WRITE_TIMEOUT_MS,
        unavailable: UNAVAILABLE,
      });
      if (
        !isRecord(body) ||
        !isInt(body.seq) ||
        !(body.status === "committed" || body.status === "pending" || body.status === "relaying") ||
        !isNullableString(body.commitTx)
      )
        throw new Error("Invalid strategy response.");
      return body as StrategyCommitResult;
    },
    async subscribe(id) {
      const body = await sendJson("POST", url(`/v1/strategies/${id}/subscriptions`), undefined, {
        unavailable: UNAVAILABLE,
      });
      if (!isRecord(body) || !isWord(body.subscriberKey) || typeof body.expiresAt !== "string")
        throw new Error("Invalid strategy response.");
      return { subscriberKey: body.subscriberKey, expiresAt: body.expiresAt };
    },
    async signal(id, subscriberKey, abort) {
      const body = await sendJson("GET", url(`/v1/strategies/${id}/signal`), undefined, {
        ...(abort ? { signal: abort } : {}),
        headers: { "x-subscriber-key": subscriberKey },
        unavailable: UNAVAILABLE,
      });
      if (!isRecord(body) || body.strategyId !== id) throw new Error("Invalid strategy response.");
      const signal = body.signal;
      if (signal === null) return null;
      if (
        !isRecord(signal) ||
        !isInt(signal.seq) ||
        !isWord(signal.commitment) ||
        !isNullableString(signal.committedAt) ||
        !isNullableString(signal.commitTx) ||
        !Array.isArray(signal.assets) ||
        signal.assets.length === 0 ||
        !signal.assets.every(isSealedAsset) ||
        !isWord(signal.salt)
      )
        throw new Error("Invalid strategy response.");
      return signal as StrategySignal;
    },
  };
}

/** The API origin strategies, the feed and social features use. */
export const strategyApiBase =
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : "");

export const strategyService = createStrategyService(strategyApiBase);
