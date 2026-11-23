import type {
  SealedAssetView,
  StrategyCard,
  StrategyCommitResult,
  StrategyDetail,
  StrategyService,
  StrategySignal,
} from "@/domain/strategies";
import { ApiError, getJson, sendJson } from "./http";

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

function isCard(value: unknown): value is StrategyCard {
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

function isSealedAsset(value: unknown): value is SealedAssetView {
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
  if (!isCard(value) || !Array.isArray((value as { history?: unknown }).history))
    throw new Error("Invalid strategy response.");
  const history = (value as unknown as { history: unknown[] }).history;
  for (const entry of history)
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
  return value as StrategyDetail;
}

export function createStrategyService(baseUrl: string): StrategyService {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (path: string) => {
    if (!base) throw new Error("Strategies are not configured in this build.");
    return `${base}${path}`;
  };
  return {
    async list(signers, signal = new AbortController().signal) {
      const query = signers && signers.length > 0 ? `?signers=${signers.join(",")}` : "";
      const body = await getJson(url(`/v1/strategies${query}`), signal, UNAVAILABLE);
      if (!isRecord(body) || !Array.isArray(body.list) || !body.list.every(isCard))
        throw new Error("Invalid strategy response.");
      return body.list;
    },
    async detail(id, signal = new AbortController().signal) {
      return parseDetail(await getJson(url(`/v1/strategies/${id}`), signal, UNAVAILABLE));
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

export const strategyService = createStrategyService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
