import { earnProfiles, type EarnProfileId } from "@/domain/earn/types";
import { fundingTokens, isFundingChain } from "./fundingNetworks";
import type {
  MainnetPortfolioSnapshot,
  OwnedPortfolioAsset,
  OwnedPortfolioPosition,
  FundingSourceObservation,
} from "./storedSigner";

export const vaultNames: Record<EarnProfileId, string> = {
  "ethereum-usdc": "Pendle USDC",
  "robinhood-usdg": "Steakhouse USDG",
};
export const vaultNetworks: Record<EarnProfileId, string> = {
  "ethereum-usdc": "Ethereum",
  "robinhood-usdg": "Robinhood",
};

export function vaultPositionProfile(position: OwnedPortfolioPosition): EarnProfileId | null {
  for (const profileId of Object.keys(earnProfiles) as EarnProfileId[]) {
    const profile = earnProfiles[profileId];
    if (
      position.chainId === profile.chainId &&
      position.token.toLowerCase() === profile.vault.toLowerCase()
    )
      return profileId;
  }
  return null;
}
export function portfolioVaultPosition(
  snapshot: MainnetPortfolioSnapshot | null | undefined,
  profileId: EarnProfileId,
): OwnedPortfolioPosition | null {
  return (
    canonicalRows(snapshot?.positions ?? []).find(
      (position) => vaultPositionProfile(position) === profileId,
    ) ?? null
  );
}

const monadUsdc = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

/** Latest available display amount. Never use observations to authorize spending. */
export function portfolioAssetAmount(row: OwnedPortfolioAsset, vault = false): string | null {
  if (vault) {
    const position = row as OwnedPortfolioPosition;
    return (
      position.underlyingAtoms ??
      (row.checkedAt > 0 ? (position.observedUnderlyingAtoms ?? null) : null)
    );
  }
  return row.balanceAtoms ?? (row.checkedAt > 0 ? row.observedAtoms : null);
}

/** Stablecoins retain their dollar face value when market pricing is unavailable. */
export function portfolioAssetValue(row: OwnedPortfolioAsset, vault = false): string | null {
  if (row.valueUsdAtoms != null) return row.valueUsdAtoms;
  if (row.valueUsdcAtoms !== null) return row.valueUsdcAtoms;
  if (row.decimals !== 6) return null;
  const token = row.token.toLowerCase();
  const stablecoin = vault
    ? vaultPositionProfile(row as OwnedPortfolioPosition) !== null
    : (row.chainId === 143 && (token === monadUsdc || token === "confidential:monad-usdc")) ||
      (isFundingChain(row.chainId) && token === fundingTokens[row.chainId]) ||
      Object.values(earnProfiles).some(
        (profile) => row.chainId === profile.chainId && token === profile.token.toLowerCase(),
      );
  return stablecoin ? portfolioAssetAmount(row, vault) : null;
}

function canonicalRows<T extends OwnedPortfolioAsset>(rows: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.chainId}:${row.token.toLowerCase()}:${row.owner?.toLowerCase() ?? "aggregate"}`;
    const previous = unique.get(key);
    if (
      !previous ||
      (row.complete && !row.stale && (!previous.complete || previous.stale)) ||
      (row.complete === previous.complete &&
        row.stale === previous.stale &&
        row.checkedAt > previous.checkedAt)
    )
      unique.set(key, row);
  }
  return [...unique.values()];
}

function fundingSources(snapshot: MainnetPortfolioSnapshot): FundingSourceObservation[] {
  const unique = new Map<string, FundingSourceObservation>();
  for (const row of snapshot.fundingSources ?? []) {
    const key = `${row.sourceChainId}:${row.token.toLowerCase()}:${row.owner.toLowerCase()}`;
    const previous = unique.get(key);
    if (
      !previous ||
      (row.complete && !row.stale && (!previous.complete || previous.stale)) ||
      (row.complete === previous.complete &&
        row.stale === previous.stale &&
        row.checkedAt > previous.checkedAt)
    )
      unique.set(key, row);
  }
  return [...unique.values()];
}
function publicObservedAtoms(snapshot: MainnetPortfolioSnapshot): string {
  return snapshot.fundingSources
    ? fundingSources(snapshot)
        .reduce((sum, source) => sum + BigInt(source.observedAtoms ?? "0"), 0n)
        .toString()
    : snapshot.totalAtoms;
}

/** Shared USDC input observation; native action-time checks own spendability and reservations. */
export function portfolioPublicUsdcAtoms(snapshot: MainnetPortfolioSnapshot): string | null {
  if (snapshot.fundingCash) {
    const enabled = snapshot.planningFundingChainIds;
    if (!enabled) return null;
    const sources = fundingSources(snapshot).filter((source) =>
      enabled.includes(source.sourceChainId),
    );
    if (
      enabled.some(
        (chain) =>
          !sources.some((source) => source.sourceChainId === chain && source.accountIndex === 1),
      ) ||
      sources.some(
        (source) =>
          !source.complete || source.stale || source.syncPending || source.availableAtoms === null,
      )
    )
      return null;
    return sources.reduce((sum, source) => sum + BigInt(source.availableAtoms!), 0n).toString();
  }
  return snapshot.balanceComplete === false && snapshot.totalAtoms === "0"
    ? null
    : snapshot.totalAtoms;
}

/** The private USDC figure already shown. A missing observation is not zero. */
export function portfolioPrivateUsdcAtoms(
  snapshot: MainnetPortfolioSnapshot | null | undefined,
): string | null {
  const asset = canonicalRows(snapshot?.ownedAssets ?? []).find(
    (row) => row.chainId === 143 && row.token.toLowerCase() === "confidential:monad-usdc",
  );
  const amount = asset ? portfolioAssetAmount(asset) : null;
  return typeof amount === "string" && /^(0|[1-9]\d*)$/.test(amount) ? amount : null;
}

/** A conservative Max observation; a missing source or locked private observation stays unknown. */
export function portfolioAvailableUsdcAtoms(snapshot: MainnetPortfolioSnapshot): string | null {
  const publicAtoms = portfolioPublicUsdcAtoms(snapshot);
  if (publicAtoms === null) return null;
  const privateCash = canonicalRows(snapshot.ownedAssets ?? []).find(
    (row) => row.chainId === 143 && row.token.toLowerCase() === "confidential:monad-usdc",
  );
  if (
    privateCash &&
    (!privateCash.complete || privateCash.stale || privateCash.balanceAtoms === null)
  )
    return null;
  return (BigInt(publicAtoms) + BigInt(privateCash?.balanceAtoms ?? "0")).toString();
}

export function portfolioUsdcBalance(snapshot: MainnetPortfolioSnapshot) {
  const privateCash = canonicalRows(snapshot.ownedAssets ?? []).find(
    (row) => row.chainId === 143 && row.token.toLowerCase() === "confidential:monad-usdc",
  );
  const publicAtoms = publicObservedAtoms(snapshot);
  const privateAtoms = privateCash ? (portfolioAssetAmount(privateCash) ?? "0") : "0";
  if (
    snapshot.fundingCash
      ? !snapshot.fundingSources?.some((row) => row.observedAtoms !== null) && privateAtoms === "0"
      : portfolioPublicUsdcAtoms(snapshot) === null && privateAtoms === "0"
  )
    return null;
  return {
    publicAtoms,
    privateAtoms,
    totalAtoms: (BigInt(publicAtoms) + BigInt(privateAtoms)).toString(),
  };
}

/** Display valuation only. Native totalAtoms remains the spendable Monad balance. */
export function portfolioValue(snapshot: MainnetPortfolioSnapshot) {
  let complete = snapshot.fundingCash
    ? snapshot.fundingCash.complete &&
      !snapshot.fundingCash.stale &&
      !snapshot.fundingCash.syncPending
    : snapshot.balanceComplete !== false && !snapshot.stale && !snapshot.syncPending;
  let estimated = !complete;
  let checkedAt = snapshot.checkedAt;
  for (const source of fundingSources(snapshot))
    if (source.observedAtoms !== null) checkedAt = Math.min(checkedAt, source.checkedAt);
  const sum = (rows: readonly OwnedPortfolioAsset[], vault: boolean): bigint => {
    let total = 0n;
    for (const row of canonicalRows(rows)) {
      if (
        !vault &&
        !snapshot.fundingSources &&
        row.chainId === 143 &&
        row.token.toLowerCase() === monadUsdc
      )
        continue;
      // A verified zero needs no market price. A missing balance is never a zero.
      if (row.complete && !row.stale && row.balanceAtoms === "0" && row.observedAtoms === "0")
        continue;
      checkedAt = Math.min(checkedAt, row.checkedAt);
      const value = portfolioAssetValue(row, vault);
      if (
        !row.complete ||
        row.stale ||
        row.balanceAtoms === null ||
        row.valueUsdcAtoms === null ||
        row.valuationUnavailable
      ) {
        complete = false;
        estimated = true;
      }
      if (vault && (row as OwnedPortfolioPosition).conversionEstimated) estimated = true;
      if (value !== null) {
        let amount = BigInt(value);
        if (!vault && snapshot.fundingSources) {
          const sources = fundingSources(snapshot).filter(
            (source) =>
              source.sourceChainId === row.chainId &&
              source.token.toLowerCase() === row.token.toLowerCase() &&
              source.observedAtoms !== null &&
              (!row.owner || source.owner.toLowerCase() === row.owner.toLowerCase()),
          );
          const included =
            row.fundingIncludedAtoms !== undefined
              ? sources.length
                ? BigInt(row.fundingIncludedAtoms)
                : 0n
              : sources.reduce((sum, source) => sum + BigInt(source.observedAtoms!), 0n);
          amount -= included < amount ? included : amount;
        }
        total += amount;
      }
    }
    return total;
  };
  const vaultContracts = new Set(
    (snapshot.positions ?? []).map((row) => `${row.chainId}:${row.token.toLowerCase()}`),
  );
  const assets = sum(
    (snapshot.ownedAssets ?? []).filter(
      (row) => !vaultContracts.has(`${row.chainId}:${row.token.toLowerCase()}`),
    ),
    false,
  );
  const vaults = sum(snapshot.positions ?? [], true);
  return {
    totalAtoms: (BigInt(publicObservedAtoms(snapshot)) + assets + vaults).toString(),
    liquidAtoms: publicObservedAtoms(snapshot),
    assetsAtoms: assets.toString(),
    vaultAtoms: vaults.toString(),
    complete,
    estimated,
    checkedAt,
  };
}
