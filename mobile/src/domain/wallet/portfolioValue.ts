import { earnProfiles, type EarnProfileId } from "@/domain/earn/types";
import type {
  MainnetPortfolioSnapshot,
  OwnedPortfolioAsset,
  OwnedPortfolioPosition,
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
      Object.values(earnProfiles).some(
        (profile) => row.chainId === profile.chainId && token === profile.token.toLowerCase(),
      );
  return stablecoin ? portfolioAssetAmount(row, vault) : null;
}

function canonicalRows<T extends OwnedPortfolioAsset>(rows: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.chainId}:${row.token.toLowerCase()}`;
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

/** Display valuation only. Native totalAtoms remains the spendable Monad balance. */
export function portfolioValue(snapshot: MainnetPortfolioSnapshot) {
  let complete = snapshot.balanceComplete !== false && !snapshot.stale && !snapshot.syncPending;
  let estimated = !complete;
  let checkedAt = snapshot.checkedAt;
  const sum = (rows: readonly OwnedPortfolioAsset[], vault: boolean): bigint => {
    let total = 0n;
    for (const row of canonicalRows(rows)) {
      if (!vault && row.chainId === 143 && row.token.toLowerCase() === monadUsdc) continue;
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
      if (value !== null) total += BigInt(value);
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
    totalAtoms: (BigInt(snapshot.totalAtoms) + assets + vaults).toString(),
    liquidAtoms: snapshot.totalAtoms,
    assetsAtoms: assets.toString(),
    vaultAtoms: vaults.toString(),
    complete,
    estimated,
    checkedAt,
  };
}
