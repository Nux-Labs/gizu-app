import { catalogAsset, type CatalogAsset } from "../../domain/catalog.ts";
import { ETHEREUM_PROFILE } from "../earn/vault.ts";
import { ROBINHOOD_PROFILE } from "../earn/robinhood-vault.ts";

// Catalog eligibility follows the existing deposit planners' exact identities.
// Extending these profiles also requires matching native signer policies and tests.
const profiles = [
  {
    chainId: ETHEREUM_PROFILE.chainId,
    vault: ETHEREUM_PROFILE.vault,
    asset: ETHEREUM_PROFILE.usdc,
  },
  {
    chainId: ROBINHOOD_PROFILE.chainId,
    vault: ROBINHOOD_PROFILE.vault,
    asset: ROBINHOOD_PROFILE.token,
  },
] as const;

export function nativeCatalogProfile(chainId: number, address?: string) {
  return profiles.find((profile) =>
    profile.chainId === chainId &&
    profile.vault.toLowerCase() === address?.toLowerCase(),
  );
}

export function nativeCatalogAsset(
  chainId: number,
  address: string,
  asset?: CatalogAsset,
): CatalogAsset | undefined {
  const canonical = catalogAsset(chainId, asset);
  const profile = nativeCatalogProfile(chainId, address);
  return canonical && profile?.asset.toLowerCase() === canonical.address.toLowerCase()
    ? canonical
    : undefined;
}
