/**
 * Networks a user can add USDC from. Only networks whose deposits Gizu can observe and invest
 * belong here: today that is the Monad funding address. Adding a network is one entry, plus the
 * arrival detection and receiving address that network needs.
 */
export type DepositNetworkId = "monad";

export type DepositNetwork = {
  id: DepositNetworkId;
  name: string;
  chainId: number;
  asset: "USDC";
};

export const depositNetworks: readonly DepositNetwork[] = [
  { id: "monad", name: "Monad", chainId: 143, asset: "USDC" },
];

export const defaultDepositNetwork: DepositNetwork = depositNetworks[0]!;
