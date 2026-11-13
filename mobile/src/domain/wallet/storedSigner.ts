/** Frozen replacement contract. Android and iOS native storage/access/backup implemented; exact transfers and explicit resume supported. */
export const storedSignerIdentity = {
  moduleName: "GizuStoredSigner",
  storageNamespace: "io.gizu.storedwallet.v1",
  backupFormat: "gizu-stored-wallet",
  backupVersion: 2,
  derivationVersion: "gizu-stored-evm-v1",
  recoveryPrfSaltLabel: "gizu.stored-wallet.recovery-prf.v1",
  rpId: "gizu.io",
  chainId: 10143,
} as const;

export type StoredAccount = { accountIndex: number; address: string; chainId: 10143 };
export type StoredWalletState =
  | { status: "absent" }
  | { status: "recoveryRequired" }
  | { status: "backupRequired"; walletId: string }
  | { status: "ready"; walletId: string; accounts: StoredAccount[] };
export type StoredSignerCapabilities = {
  contractVersion: 1;
  available: boolean;
  walletStorage: boolean;
  backup: boolean;
  transfers: boolean;
  swaps: boolean;
  walletRecovery?: boolean;
  walletDiscovery?: boolean;
  earnWallets?: boolean;
  earnVaultExecution?: boolean;
  earnSponsoredExecution?: boolean;
  earnEthereumLiquidityExecution?: boolean;
  earnPrivatePayoutExecution?: boolean;
  earnDepositJourney?: boolean;
  earnDepositDistribution?: boolean;
  earnDepositPrivateFunding?: boolean;
  confidentialWithdrawals?: boolean;
  confidentialSaleProceeds?: boolean;
  earnBalanceDeltaSettlement?: boolean;
  reason?: "notImplemented" | "unsupportedPlatform" | "unsupportedProvider";
};
export type StoredTransferProposal = {
  walletId: string;
  chainId: 10143;
  transfers: {
    accountIndex: number;
    expectedFrom: string;
    to: string;
    valueWei: string;
  }[];
};
export type StoredOperation = {
  operationId: string;
  revision: number;
  walletId: string;
  canResume: boolean;
  blocked: boolean;
  status: "running" | "needsAuthorization" | "needsReview" | "completed" | "cancelled";
  steps: {
    index: number;
    accountIndex: number;
    from: string;
    to: string;
    valueWei: string;
    status: "planned" | "signed" | "pending" | "unknown" | "finalized" | "reverted";
    transactionHash?: string;
    nonce?: string;
    nonceConflict?: boolean;
  }[];
};
export type StoredSwapView = {
  operationId: string;
  phase: string;
  step: string;
  pausedCode: string | null;
  targetSymbol: string;
  targetDecimals: number;
  sourceAtoms: string;
  creditedAtoms: string;
  completionTarget?: "confidential" | "public";
  privateCreditedAtoms?: string;
  payoutsSubmitted: number;
  ordersComplete: number;
  receivedTargetAtoms: string;
  fundingAddress: string;
  direction: "buy" | "sell";
  /** Funds may be in flight once approved; the app pauses such operations, never cancels them. */
  approved: boolean;
  returnAddresses: string[];
  /** How many wallets the swap spreads over; absent in states saved before it varied. */
  legs?: number;
  /** Holder wallets a sell sells from; differs from `legs` once a sell pools its proceeds. */
  holders?: number;
  kind?: string;
};

export type SwapHolding = {
  token: string;
  chainId: 4663;
  symbol: string;
  decimals: number;
  balanceAtoms: string;
  batches: { id: string; balanceAtoms: string }[];
};
export type SwapHoldingsSnapshot = {
  holdings: SwapHolding[];
  checkedAt: number;
  block: string;
};

export type OwnedPortfolioAsset = {
  assetId: string;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number | null;
  balanceAtoms: string | null;
  observedAtoms: string;
  complete: boolean;
  stale: boolean;
  checkedAt: number;
  valueUsdcAtoms: string | null;
  /** Display value in millionths of USD, separate from native USDC-denominated values. */
  valueUsdAtoms?: string | null;
  valuationUnavailable: boolean;
};
export type OwnedPortfolioPosition = OwnedPortfolioAsset & {
  shareDecimals?: number | null;
  conversionEstimated?: boolean;
  shareAtoms: string | null;
  underlyingAtoms: string | null;
  observedUnderlyingAtoms?: string | null;
};

export type MainnetPortfolioSnapshot = {
  confidentialReadState?: "ready" | "locked" | "unavailable" | "partial";
  ownedAssets?: OwnedPortfolioAsset[];
  positions?: OwnedPortfolioPosition[];
  valuationComplete?: boolean;
  /** Expiry of externally priced display values; never used for spending. */
  valuationExpiresAt?: number;
  ownedBalanceComplete?: boolean;
  ownedStale?: boolean;
  ownedSyncPending?: boolean;
  ownedCheckedAt?: number;
  balanceComplete?: boolean;
  stale?: boolean;
  syncPending?: boolean;
  walletId: string;
  chainId: 143;
  asset: "USDC";
  decimals: 6;
  fundingAddress: string;
  fundingAtoms: string;
  returnAtoms: string;
  totalAtoms: string;
  checkedAt: number;
  block: string;
  accounts: {
    address: string;
    accountIndex: number;
    role: "funding" | "receiving";
    balanceAtoms: string;
  }[];
  history: {
    operationId: string;
    phase: string;
    direction: "buy" | "sell";
    symbol: string;
    receivedAtoms: string;
    completionTarget?: "confidential" | "public";
    privateCreditedAtoms?: string;
    recordedAt: number;
  }[];
};

/** All dialogs, file IO and authorization originate natively. No JS approve/export API. */
export interface StoredSignerContract {
  prepareNewEarnDistributionIntent?(
    walletId: string,
    profile: string,
    budgetAtoms: string,
  ): Promise<unknown>;
  selectEarnInvestmentSlot?(walletId: string, intentId: string, slot: number): Promise<unknown>;
  getWalletRecoveryStatus?(walletId: string): Promise<unknown>;
  syncWalletRecovery?(walletId: string): Promise<unknown>;
  restoreWalletRecovery?(walletId: string): Promise<unknown>;
  discoverWallets?(walletId: string, throughCycle: number): Promise<unknown>;
  cancelWalletDiscovery?(walletId: string): Promise<unknown>;
  prepareEarnDeposit?(
    walletId: string,
    profileId: string,
    budgetAtoms: string,
    draftId: string | null,
  ): Promise<unknown>;
  readEarnDepositFundingBalance?(request: { walletId: string }): Promise<unknown>;
  confirmEarnDeposit?(walletId: string, journeyId: string, revision: number): Promise<unknown>;
  getEarnDepositStatus?(walletId: string, journeyId: string): Promise<unknown>;
  findEarnDeposit?(walletId: string, profileId: string): Promise<unknown>;
  resumeEarnDeposit?(walletId: string, journeyId: string, revision: number): Promise<unknown>;
  cancelEarnDeposit?(walletId: string, journeyId: string, revision: number): Promise<unknown>;
  discardEarnDepositDraft?(walletId: string, journeyId: string): Promise<void>;
  getCapabilities(): Promise<StoredSignerCapabilities>;
  getWalletState(): Promise<StoredWalletState>;
  createWallet(): Promise<StoredWalletState>;
  openWallet(): Promise<StoredWalletState>;
  /** Native save + reopen + verify ceremony; never returns file contents or paths. */
  backupWallet(): Promise<StoredWalletState>;
  restoreWallet(): Promise<StoredWalletState>;
  executeOperation(proposal: StoredTransferProposal): Promise<StoredOperation>;
  listOperations(): Promise<StoredOperation[]>;
  getOperationStatus(operationId: string): Promise<StoredOperation>;
  /** Reconcile then obtain new native review and passkey authorization; never automatic. */
  resumeOperation(operationId: string, expectedRevision: number): Promise<StoredOperation>;
  cancelOperation(operationId: string): Promise<StoredOperation>;
  getMainnetPortfolio(): Promise<MainnetPortfolioSnapshot>;
  /** Local encrypted observations only; performs no network reads or authorization. */
  getCachedMainnetPortfolio?(): Promise<MainnetPortfolioSnapshot>;
  getConfidentialWithdrawal?(walletId: string): Promise<unknown>;
  prepareConfidentialWithdrawal?(request: {
    walletId: string;
    amountAtoms: string;
  }): Promise<unknown>;
  executeConfidentialWithdrawal?(request: {
    walletId: string;
    operationId: string;
    revision: number;
  }): Promise<unknown>;
  resumeConfidentialWithdrawal?(request: {
    walletId: string;
    operationId: string;
  }): Promise<unknown>;
  cancelConfidentialWithdrawal?(request: {
    walletId: string;
    operationId: string;
  }): Promise<unknown>;
  getSwapDeposit(): Promise<{ fundingAddress: string }>;
  startSwap(target: string, amountAtoms: string, gateway: string): Promise<StoredSwapView>;
  getSwapHoldings(target: string): Promise<SwapHoldingsSnapshot>;
  sellSwapHolding(holdingId: string, gateway: string): Promise<StoredSwapView>;
  startSell(gateway: string): Promise<StoredSwapView>;
  /** Buy `target` with the private balance C already holds; nothing is sent from Monad. */
  startPayout(target: string, gateway: string): Promise<StoredSwapView>;
  /** Temporary: finish Fusion buys for allocated recipients still holding USDG. */
  startRecovery(target: string, gateway: string): Promise<StoredSwapView>;
  resumeSwap(gateway: string): Promise<StoredSwapView>;
  getSwapStatus(gateway: string): Promise<StoredSwapView | { phase: "NONE" }>;
  cancelSwap(gateway: string): Promise<StoredSwapView>;
  /** Native intent review, authorization and immutable public wallet pair. No signing. */
  prepareEarnIntent?(walletId: string, profile: string): Promise<unknown>;
  getEarnIntent?(walletId: string): Promise<unknown>;
  /** Native-only authentication/signature and transport; public balance result only. */
  executeEarnFundingBatch?(walletId: string, fundingBatchId: string): Promise<unknown>;
  registerEarnFundingPlans?(
    walletId: string,
    requests: import("@/domain/earn/sourceFunding").SponsoredRequest[],
  ): Promise<unknown>;
  planPublicFunding?(walletId: string, budgetAtoms: string): Promise<unknown>;
  prepareEarnSourceQuoteForAccount?(
    walletId: string,
    sourceIndex: number,
    amountAtoms: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  prepareNewEarnIntent?(walletId: string, profile: string): Promise<unknown>;
  listEarnIntents?(walletId: string): Promise<unknown>;
  listEarnInvestmentPositions?(walletId: string): Promise<unknown>;
  selectEarnIntent?(walletId: string, intentId: string): Promise<unknown>;
  readEarnBalance?(walletId: string): Promise<unknown>;
  executeEarnVault?(
    proposal: import("@/domain/earn/vaultExecution").VaultProposal,
  ): Promise<unknown>;
  listEarnVaultOperations?(walletId: string): Promise<unknown>;
  resumeEarnVaultOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelEarnVaultOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  prepareEarnSourceQuote?(
    walletId: string,
    amountAtoms: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  executeEarnSponsored?(
    request:
      | import("@/domain/earn/sourceFunding").SponsoredRequest
      | import("@/domain/earn/robinhoodExecution").RobinhoodRequest,
  ): Promise<unknown>;
  continueEarnWithdrawal?(
    request: import("@/domain/earn/robinhoodExecution").RobinhoodRequest,
  ): Promise<unknown>;
  listEarnSponsoredOperations?(walletId: string): Promise<unknown>;
  listEarnCycleOperations?(
    walletId: string,
    cycleIndex: number,
    investmentSlot: number,
  ): Promise<unknown>;
  resumeEarnSponsoredOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelEarnSponsoredOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  readEarnSponsoredSettlement?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  prepareEarnFusionQuote?(request: {
    walletId: string;
    operationId: string;
    revision: number;
    inputAtoms: string;
    resolverGasPriceWei: string;
    minimumEthWei: string;
    maximumResolverOverheadWei: string;
    fundingMode: "permit";
  }): Promise<unknown>;
  prepareEarnEthereumReturnQuote?(
    walletId: string,
    amountAtoms: string,
    operationId: string,
    revision: number,
    returnAsset: "usdc" | "native",
  ): Promise<unknown>;
  executeEarnEthereumLiquidity?(
    request: import("@/domain/earn/ethereumLiquidity").LiquidityRequest,
  ): Promise<unknown>;
  listEarnEthereumLiquidityOperations?(walletId: string): Promise<unknown>;
  resumeEarnEthereumLiquidityOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelEarnEthereumLiquidityOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelPendingEarnEthereumLiquidityOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  readEarnEthereumLiquiditySettlement?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  executeEarnPrivatePayout?(
    request: import("@/domain/earn/privatePayout").PayoutRequest,
  ): Promise<unknown>;
  listEarnPrivatePayoutOperations?(walletId: string): Promise<unknown>;
  resumeEarnPrivatePayoutOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelEarnPrivatePayoutOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  readEarnPrivatePayoutSettlement?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  executeEarnWithdrawal?(
    walletId: string,
    returnOperationId: string,
    revision: number,
  ): Promise<unknown>;
  listEarnWithdrawalOperations?(walletId: string): Promise<unknown>;
  resumeEarnWithdrawalOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelEarnWithdrawalOperation?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  readEarnWithdrawalSettlement?(
    walletId: string,
    operationId: string,
    revision: number,
  ): Promise<unknown>;
  cancelWalletOperation?(): void;
  lock(): void;
}
