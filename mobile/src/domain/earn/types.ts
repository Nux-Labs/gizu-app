export const monadConfidentialUsdcAssetId =
  "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
export type EarnProfileId = "ethereum-usdc" | "robinhood-usdg";
export const earnProfiles = {
  "ethereum-usdc": {
    name: "Ethereum · Pendle",
    chainId: 1,
    symbol: "USDC",
    decimals: 6,
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    vault: "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
    gas: "ETH",
  },
  "robinhood-usdg": {
    name: "Robinhood · Steakhouse",
    chainId: 4663,
    symbol: "USDG",
    decimals: 6,
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    vault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
    gas: "USDG paymaster",
  },
} as const;
export type EarnOwner = { walletId: string; address?: string };
export type EarnDestination = {
  role: "hold" | "invest";
  slot?: number;
  address: string;
  chainId: 1 | 4663;
};
export type EarnIntent = {
  status: "prepared" | "recoveryRequired";
  version: "gizu-earn-v1" | "gizu-earn-v2";
  cycleIndex?: number;
  intentId: string;
  walletId: string;
  profileId: EarnProfileId;
  sourceAddress: string;
  sourceChainId: 143;
  confidentialAddress: string;
  backupCovered: true;
  destinations: [EarnDestination, ...EarnDestination[]];
  distribution?: import("./distribution").EarnDistribution;
  investmentSlot?: number;
  distributionBudgetAtoms?: string;
};
export type EarnWalletState = EarnIntent | { status: "absent" | "recoveryRequired" };
export interface EarnWalletService {
  load(owner: EarnOwner): Promise<EarnWalletState>;
  prepare(owner: EarnOwner, profile: EarnProfileId): Promise<EarnIntent>;
  list?(owner: EarnOwner): Promise<EarnIntent[]>;
  prepareNew?(owner: EarnOwner, profile: EarnProfileId): Promise<EarnIntent>;
  prepareDistribution?(
    owner: EarnOwner,
    profile: EarnProfileId,
    budgetAtoms: string,
  ): Promise<EarnIntent>;
  selectInvestmentSlot?(owner: EarnOwner, intentId: string, slot: number): Promise<EarnIntent>;
  select?(owner: EarnOwner, intentId: string): Promise<EarnIntent>;
  cancel(): void;
}
export type EarnPreflight = {
  profileId: EarnProfileId;
  chainId: 1 | 4663;
  owner: string;
  token: string;
  vault: string;
  tokenDecimals: 6;
  blockNumber: string;
  blockHash: string;
  timestampMs: number;
  tokenBalance: string;
  nativeBalance: string;
  shares: string;
  newCycleReady: boolean;
  blockGas: { baseFee: string; gasUsed: string; gasLimit: string };
  feeHistoryReward: string[] | null;
  readOnly: true;
  executionAvailable: false;
  simulationAvailable: false;
};
export interface EarnPreflightService {
  check(profileId: EarnProfileId, owner: string, signal: AbortSignal): Promise<EarnPreflight>;
}

export type EarnPrivateBalance = {
  confidentialAddress: string;
  assetId: string;
  available: string;
  timestampMs: number;
  authenticated: true;
  operationScoped: false;
};
export interface EarnPrivateBalanceService {
  read(intent: EarnIntent): Promise<EarnPrivateBalance>;
  cancel(): void;
}
