import { earnProfiles } from "@/domain/earn/types";
import { assertFresh } from "@/domain/earn/policy";
import { hoodWrappedNative } from "@/domain/earn/robinhoodExecution";
import { earnAtoms, earnObject } from "@/domain/earn/vaultExecution";
import { portfolioValue, vaultPositionProfile } from "@/domain/wallet/portfolioValue";
import type {
  MainnetPortfolioSnapshot,
  OwnedPortfolioAsset,
  OwnedPortfolioPosition,
} from "@/domain/wallet/storedSigner";
import { assertNotAborted } from "@/services/earn/abort";

export interface PortfolioValuationService {
  value(snapshot: MainnetPortfolioSnapshot, signal: AbortSignal): Promise<MainnetPortfolioSnapshot>;
}
type Price = { token: bigint; usdc: bigint; observedAt: number; expiresAt: number };
const profileId = "robinhood-usdg";
const profile = earnProfiles[profileId];
const same = (value: unknown, expected: string) =>
  typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
const hash = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("Invalid portfolio price timestamp.");
  return value;
}
function priceQuantity(value: unknown): bigint {
  const result = BigInt(earnAtoms(value));
  if (result === 0n) throw Error("Missing portfolio price.");
  return result;
}

/** Validate the deployed exit-snapshot's read-only bindings; its balances are not portfolio balances. */
function parsePrice(raw: unknown, owner: string, now: number): Price {
  const r = earnObject(raw);
  if (
    r.profileId !== profileId ||
    r.chainId !== profile.chainId ||
    !same(r.owner, owner) ||
    !same(r.token, profile.token) ||
    !same(r.vault, profile.vault) ||
    !same(r.wrappedToken, hoodWrappedNative) ||
    r.tokenDecimals !== 6 ||
    r.wrappedDecimals !== 18 ||
    typeof r.shareDecimals !== "number" ||
    !Number.isInteger(r.shareDecimals) ||
    r.shareDecimals < 0 ||
    r.shareDecimals > 36 ||
    r.readOnly !== true ||
    r.completionAttested !== false ||
    r.walletScope !== "investment-only-hold-wallet-excluded" ||
    r.priceMaxAgeMs !== 300000 ||
    !hash(r.snapshotHash)
  )
    throw Error("Portfolio price binding changed.");
  const prices = earnObject(r.prices);
  const reference = earnObject(r.reference);
  const balances = earnObject(r.balances);
  for (const key of ["tokenAtoms", "nativeWei", "wrappedWei", "shares"]) earnAtoms(balances[key]);
  if (BigInt(earnAtoms(reference.blockNumber)) === 0n || !hash(reference.blockHash))
    throw Error("Invalid portfolio price reference.");
  const observedAt = timestamp(r.observedAtMs);
  const blockAt = timestamp(reference.blockTimestampMs);
  const priceAt = timestamp(prices.observedAtMs);
  assertFresh({ timestampMs: observedAt, nowMs: now });
  assertFresh({ timestampMs: blockAt, nowMs: now });
  const priceTime = (value: unknown) => {
    if (typeof value !== "string") throw Error("Missing provider timestamp.");
    const at = timestamp(Date.parse(value));
    assertFresh({ timestampMs: at, nowMs: now, maxAgeMs: 300000 });
    return at;
  };
  const tokenAt = priceTime(prices.tokenPriceUpdatedAt);
  const usdcAt = priceTime(prices.usdcPriceUpdatedAt);
  const needsEth =
    BigInt(balances.nativeWei as string) + BigInt(balances.wrappedWei as string) > 0n;
  const ethAt = needsEth ? priceTime(prices.ethPriceUpdatedAt) : null;
  if (needsEth) priceQuantity(prices.ethUsd18);
  else if (prices.ethPriceUpdatedAt !== null || prices.ethUsd18 !== null)
    throw Error("Unexpected native price.");
  const expiresAt = timestamp(r.expiresAtMs);
  if (
    priceAt !== Math.min(tokenAt, usdcAt, ...(ethAt === null ? [] : [ethAt])) ||
    expiresAt <= now ||
    expiresAt !== Math.min(priceAt + 300000, blockAt + 60000, observedAt + 60000) ||
    observedAt < Math.max(priceAt, blockAt) - 5000
  )
    throw Error("Portfolio prices expired.");
  return {
    token: priceQuantity(prices.tokenUsd18),
    usdc: priceQuantity(prices.usdcUsd18),
    observedAt: priceAt,
    expiresAt,
  };
}

function supported(row: OwnedPortfolioAsset, vault: boolean): boolean {
  return vault
    ? vaultPositionProfile(row as OwnedPortfolioPosition) === profileId
    : row.chainId === profile.chainId && same(row.token, profile.token);
}
function fresh(row: OwnedPortfolioAsset, now: number): boolean {
  return (
    row.complete &&
    !row.stale &&
    row.balanceAtoms !== null &&
    row.decimals === 6 &&
    Number.isSafeInteger(row.checkedAt) &&
    now - row.checkedAt >= -5000 &&
    now - row.checkedAt < 30000
  );
}
function amount(row: OwnedPortfolioAsset, vault: boolean): string | null {
  return vault ? (row as OwnedPortfolioPosition).underlyingAtoms : row.balanceAtoms;
}
export function createPortfolioValuationService(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now,
): PortfolioValuationService {
  // Cache only reusable public prices. Never retain the lookup owner or raw response.
  let cachedPrice: Price | undefined;
  async function loadPrice(owner: string, signal: AbortSignal): Promise<Price> {
    if (cachedPrice && cachedPrice.expiresAt > now()) return cachedPrice;
    cachedPrice = undefined;
    if (!baseUrl || !/^0x[0-9a-f]{40}$/i.test(owner)) throw Error("Portfolio pricing unavailable.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    let rejectAborted: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = () => {
        const error = new Error("Portfolio pricing cancelled.");
        error.name = "AbortError";
        reject(error);
      };
      controller.signal.addEventListener("abort", rejectAborted);
    });
    const timeout = setTimeout(abort, 20000);
    try {
      const price = await Promise.race([
        (async () => {
          const response = await fetcher(baseUrl.replace(/\/$/, "") + "/v1/earn/exit-snapshot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profileId, owner }),
            signal: controller.signal,
          });
          if (!response.ok) throw Error("Portfolio price unavailable.");
          const raw: unknown = await response.json();
          assertNotAborted(controller.signal);
          return parsePrice(raw, owner, now());
        })(),
        cancelled,
      ]);
      assertNotAborted(signal);
      cachedPrice = price;
      return price;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }
  return {
    async value(snapshot, signal) {
      assertNotAborted(signal);
      const at = now();
      const needsPrice = (row: OwnedPortfolioAsset, vault: boolean) =>
        supported(row, vault) &&
        fresh(row, at) &&
        amount(row, vault) !== null &&
        amount(row, vault) !== "0";
      let price: Price | undefined;
      if (
        (snapshot.ownedAssets ?? []).some((row) => needsPrice(row, false)) ||
        (snapshot.positions ?? []).some((row) => needsPrice(row, true))
      ) {
        try {
          price = await loadPrice(snapshot.fundingAddress, signal);
        } catch {
          assertNotAborted(signal); /* Preserve native balances when read-only prices fail. */
        }
      }
      assertNotAborted(signal);
      const enrich = <T extends OwnedPortfolioAsset>(row: T, vault: boolean): T => {
        if (!supported(row, vault)) return row;
        const atoms = amount(row, vault);
        if (!fresh(row, now()) || atoms === null || !price || price.expiresAt <= now())
          return { ...row, valueUsdcAtoms: null, valuationUnavailable: true };
        try {
          return {
            ...row,
            valueUsdcAtoms: ((BigInt(earnAtoms(atoms)) * price.token) / price.usdc).toString(),
            valuationUnavailable: false,
            checkedAt: Math.min(row.checkedAt, price.observedAt),
          };
        } catch {
          return { ...row, valueUsdcAtoms: null, valuationUnavailable: true };
        }
      };
      const result = {
        ...snapshot,
        valuationExpiresAt: price
          ? Math.min(
              price.expiresAt,
              ...[...(snapshot.ownedAssets ?? []), ...(snapshot.positions ?? [])]
                .filter((row) => supported(row, "shareAtoms" in row) && fresh(row, now()))
                .map((row) => row.checkedAt + 30000),
            )
          : undefined,
        ownedAssets: snapshot.ownedAssets?.map((row) => enrich(row, false)),
        positions: snapshot.positions?.map((row) => enrich(row, true)),
      };
      return { ...result, valuationComplete: portfolioValue(result).complete };
    },
  };
}

/** Remove expired prices while retaining the independently read token/share balances. */
export function expirePortfolioValuation(
  snapshot: MainnetPortfolioSnapshot,
): MainnetPortfolioSnapshot {
  const clear = <T extends OwnedPortfolioAsset>(row: T, vault: boolean): T =>
    supported(row, vault) ? { ...row, valueUsdcAtoms: null, valuationUnavailable: true } : row;
  return {
    ...snapshot,
    valuationExpiresAt: undefined,
    valuationComplete: false,
    ownedAssets: snapshot.ownedAssets?.map((row) => clear(row, false)),
    positions: snapshot.positions?.map((row) => clear(row, true)),
  };
}
export const portfolioValuationService = createPortfolioValuationService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
