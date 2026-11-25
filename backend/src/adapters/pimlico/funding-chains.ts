import { defineChain, getAddress, type Address, type Chain } from "viem";
import {
  arbitrumUsdcAssetId,
  baseUsdcAssetId,
  monadUsdcAssetId,
} from "../aurora/assets.ts";

export type FundingChainId = 143 | 8453 | 42161;
export type FundingChain = Readonly<{
  id: FundingChainId;
  token: Address;
  originAsset: string;
  decimals: 6;
  rpcUrl: string;
  chain: Chain;
}>;

function source(
  id: FundingChainId,
  name: string,
  symbol: string,
  rpcUrl: string,
  token: string,
  originAsset: string,
): FundingChain {
  return Object.freeze({
    id,
    token: getAddress(token),
    originAsset,
    decimals: 6,
    rpcUrl,
    chain: defineChain({
      id,
      name,
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    }),
  });
}

const sources: Readonly<Record<FundingChainId, FundingChain>> = Object.freeze({
  143: source(
    143,
    "Monad",
    "MON",
    "https://rpc.monad.xyz",
    "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    monadUsdcAssetId,
  ),
  8453: source(
    8453,
    "Base",
    "ETH",
    "https://mainnet.base.org",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    baseUsdcAssetId,
  ),
  42161: source(
    42161,
    "Arbitrum One",
    "ETH",
    "https://arb1.arbitrum.io/rpc",
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    arbitrumUsdcAssetId,
  ),
});

/** Funding origins only. Trading/vault destination chains have separate admission. */
export function fundingChain(id: number): FundingChain {
  if (id !== 143 && id !== 8453 && id !== 42161)
    throw new Error("Unsupported funding chain");
  return sources[id];
}
