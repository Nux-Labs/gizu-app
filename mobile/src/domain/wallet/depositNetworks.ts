import { fundingTokens } from "./fundingNetworks";
import type { FundingChainId } from "./storedSigner";
export type DepositNetworkId = "monad" | "base" | "arbitrum";

export type DepositNetwork = {
  id: DepositNetworkId;
  name: string;
  chainId: FundingChainId;
  asset: "USDC";
  token: string;
};

export const depositNetworks: readonly DepositNetwork[] = [
  { id: "monad", name: "Monad", chainId: 143, asset: "USDC", token: fundingTokens[143] },
  { id: "base", name: "Base", chainId: 8453, asset: "USDC", token: fundingTokens[8453] },
  { id: "arbitrum", name: "Arbitrum", chainId: 42161, asset: "USDC", token: fundingTokens[42161] },
];

export const defaultDepositNetwork: DepositNetwork = depositNetworks[0]!;
