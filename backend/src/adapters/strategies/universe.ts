import { getAddress, type Address } from "viem";
import type { StrategyAssetRef } from "../../domain/strategy.ts";
import { ROBINHOOD_PROFILE } from "../earn/robinhood-vault.ts";
import { ETHEREUM_PROFILE } from "../earn/vault.ts";
import { BUY_TARGETS } from "../oneinch/swap-targets.ts";

/** Base USDC, the basket's cash leg; the native signer pins the same address. */
export const STRATEGY_BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

const tokens = new Map<number, Set<Address>>([
  [8453, new Set([STRATEGY_BASE_USDC, ...BUY_TARGETS[8453].map((t) => getAddress(t.address))])],
  [4663, new Set(BUY_TARGETS[4663].map((t) => getAddress(t.address)))],
]);
const vaults = new Map<number, Address>([
  [ROBINHOOD_PROFILE.chainId, ROBINHOOD_PROFILE.vault],
  [ETHEREUM_PROFILE.chainId, ETHEREUM_PROFILE.vault],
]);

/** Buyable Base and Robinhood stocks, Base USDC and Gizu's Earn vaults, as the signer allows. */
export function inStrategyUniverse(asset: StrategyAssetRef): boolean {
  const address = getAddress(asset.address);
  return asset.kind === 0
    ? tokens.get(asset.chainId)?.has(address) === true
    : vaults.get(asset.chainId) === address;
}

export const STRATEGY_VAULT_ASSET_DECIMALS = 6;
