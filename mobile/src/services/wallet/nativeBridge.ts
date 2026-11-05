import { requireOptionalNativeModule } from "expo";
import type { StoredWalletBridge } from "./storedAccess";
import type { StoredSignerContract, StoredSignerCapabilities } from "@/domain/wallet/storedSigner";
import { AppState, Platform } from "react-native";
import { NativeCallQueue } from "./nativeCallQueue";

let authorizationGeneration = 0;

function supportedPlatform() {
  return (
    (Platform.OS === "android" && Number(Platform.Version) >= 28) ||
    (Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 18)
  );
}
const calls = new NativeCallQueue();
const wrapped = new WeakMap<StoredSignerContract, StoredSignerContract>();
let observingLifecycle = false;
const coalescedReads = new Set([
  "getWalletState",
  "getSwapDeposit",
  "getMainnetPortfolio",
  "getSwapHoldings",
  "getSwapStatus",
  "getEarnDepositStatus",
  "getWalletRecoveryStatus",
]);
function nativeModule(): StoredSignerContract | null {
  const native = supportedPlatform()
    ? requireOptionalNativeModule<StoredSignerContract>("GizuStoredSigner")
    : null;
  if (!native) return null;
  if (!observingLifecycle) {
    observingLifecycle = true;
    AppState.addEventListener("change", (state) => {
      if (state !== "active") calls.cancelPending();
    });
  }
  const previous = wrapped.get(native);
  if (previous) return previous;
  // Keep native storage and signing locks intact. All adapters share this admission queue.
  const adapter = new Proxy(native, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function" || typeof property !== "string") return value;
      if (property === "getCapabilities") return value.bind(target);
      if (property === "lock") return () => calls.lock(() => value.call(target));
      return (...args: unknown[]) => {
        const work = () => value.apply(target, args);
        if (
          property === "cancelSwap" ||
          property === "cancelOperation" ||
          property === "cancelEarnDeposit" ||
          property === "cancelWalletDiscovery"
        )
          return calls.interrupt(work);
        const readKey = coalescedReads.has(property)
          ? JSON.stringify([property, ...args])
          : undefined;
        if (
          (property === "getEarnDepositStatus" || property === "getWalletRecoveryStatus") &&
          readKey
        )
          return calls.snapshot(work, readKey);
        return calls.run(work, readKey);
      };
    },
  });
  wrapped.set(native, adapter);
  return adapter;
}
export async function getSignerCapabilities(): Promise<StoredSignerCapabilities> {
  const unavailable: StoredSignerCapabilities = {
    contractVersion: 1,
    available: false,
    walletStorage: false,
    backup: false,
    transfers: false,
    swaps: false,
    reason: supportedPlatform() ? "notImplemented" : "unsupportedPlatform",
  };
  try {
    const native = nativeModule();
    if (!native) return unavailable;
    const result = await native.getCapabilities();
    if (result.contractVersion !== 1 || result.available !== true) return unavailable;
    return {
      contractVersion: 1,
      available: true,
      walletStorage: result.walletStorage === true,
      backup: result.backup === true,
      transfers: result.transfers === true,
      swaps: result.swaps === true,
      walletRecovery: Platform.OS === "android" && result.walletRecovery === true,
      walletDiscovery: Platform.OS === "android" && result.walletDiscovery === true,
      earnWallets: result.earnWallets === true,
      earnVaultExecution: result.earnVaultExecution === true,
      earnSponsoredExecution: result.earnSponsoredExecution === true,
      earnEthereumLiquidityExecution: result.earnEthereumLiquidityExecution === true,
      earnPrivatePayoutExecution: result.earnPrivatePayoutExecution === true,
      earnBalanceDeltaSettlement:
        Platform.OS === "android" && result.earnBalanceDeltaSettlement === true,
      earnDepositJourney: Platform.OS === "android" && result.earnDepositJourney === true,
      earnDepositDistribution: Platform.OS === "android" && result.earnDepositDistribution === true,
    };
  } catch {
    return unavailable;
  }
}
export class WalletUnavailableError extends Error {
  constructor() {
    super(
      supportedPlatform()
        ? "Wallet access is temporarily unavailable in this build or its native capabilities are not ready."
        : "Wallet access requires Android 9+ or iOS 18+ and the installed Gizu app.",
    );
  }
}
async function checked(
  native: StoredSignerContract,
  capability:
    | "walletStorage"
    | "backup"
    | "transfers"
    | "swaps"
    | "walletRecovery"
    | "walletDiscovery"
    | "earnWallets"
    | "earnVaultExecution"
    | "earnSponsoredExecution"
    | "earnEthereumLiquidityExecution"
    | "earnPrivatePayoutExecution"
    | "earnDepositJourney",
) {
  const generation = authorizationGeneration;
  const value = await native.getCapabilities();
  if (generation !== authorizationGeneration) throw new Error("Wallet operation cancelled.");
  if (value.contractVersion !== 1 || value.available !== true || value[capability] !== true)
    throw new WalletUnavailableError();
}
// Scheduling occurs at the native boundary so reads also coordinate with user actions.
function readNative<T>(work: () => Promise<T>): Promise<T> {
  return work();
}
export type StoredWalletRecoveryBridge = {
  getWalletRecoveryStatus(walletId: string): Promise<unknown>;
  syncWalletRecovery(walletId: string): Promise<unknown>;
  restoreWalletRecovery(walletId: string): Promise<unknown>;
  discoverWallets(walletId: string, throughCycle: number): Promise<unknown>;
  cancelWalletDiscovery(walletId: string): Promise<unknown>;
};
export function getStoredWalletRecoverySigner(): StoredWalletRecoveryBridge | null {
  const native = nativeModule();
  if (!native || Platform.OS !== "android") return null;
  async function invoke(
    method: keyof StoredWalletRecoveryBridge,
    walletId: string,
    throughCycle?: number,
  ) {
    await checked(
      native!,
      method === "discoverWallets" || method === "cancelWalletDiscovery"
        ? "walletDiscovery"
        : "walletRecovery",
    );
    const action = native![method];
    if (typeof action !== "function") throw new WalletUnavailableError();
    return method === "discoverWallets"
      ? native!.discoverWallets!(walletId, throughCycle!)
      : (action as (id: string) => Promise<unknown>)(walletId);
  }
  return {
    getWalletRecoveryStatus: (id) => invoke("getWalletRecoveryStatus", id),
    syncWalletRecovery: (id) => invoke("syncWalletRecovery", id),
    restoreWalletRecovery: (id) => invoke("restoreWalletRecovery", id),
    discoverWallets: (id, bound) => invoke("discoverWallets", id, bound),
    cancelWalletDiscovery: (id) => invoke("cancelWalletDiscovery", id),
  };
}
export function getStoredSigner(): StoredWalletBridge | null {
  const native = nativeModule();
  if (!native) return null;
  return {
    getSwapDeposit() {
      return readNative(async () => {
        await checked(native, "walletStorage");
        return native.getSwapDeposit();
      });
    },
    async getWalletState() {
      await checked(native, "walletStorage");
      return native.getWalletState();
    },
    async createWallet() {
      await checked(native, "walletStorage");
      return native.createWallet();
    },
    async openWallet() {
      await checked(native, "walletStorage");
      return native.openWallet();
    },
    async backupWallet() {
      await checked(native, "backup");
      return native.backupWallet();
    },
    async restoreWallet() {
      await checked(native, "backup");
      return native.restoreWallet();
    },
    lock: () => {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export type StoredTransferBridge = Pick<
  StoredSignerContract,
  | "executeOperation"
  | "listOperations"
  | "getOperationStatus"
  | "resumeOperation"
  | "cancelOperation"
  | "lock"
>;
export function getStoredTransferSigner(): StoredTransferBridge | null {
  const native = nativeModule();
  if (!native) return null;
  return {
    async executeOperation(proposal) {
      await checked(native, "transfers");
      return native.executeOperation(proposal);
    },
    async listOperations() {
      await checked(native, "transfers");
      return native.listOperations();
    },
    async getOperationStatus(id) {
      await checked(native, "transfers");
      return native.getOperationStatus(id);
    },
    async resumeOperation(id, revision) {
      await checked(native, "transfers");
      return native.resumeOperation(id, revision);
    },
    async cancelOperation(id) {
      await checked(native, "transfers");
      return native.cancelOperation(id);
    },
    lock: () => {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export type StoredSwapBridge = Pick<
  StoredSignerContract,
  | "getMainnetPortfolio"
  | "getSwapDeposit"
  | "getSwapHoldings"
  | "sellSwapHolding"
  | "sweepSwapHolding"
  | "startSwap"
  | "startSell"
  | "startPayout"
  | "startRecovery"
  | "resumeSwap"
  | "getSwapStatus"
  | "cancelSwap"
  | "lock"
>;
export function getStoredSwapSigner(): StoredSwapBridge | null {
  const native = nativeModule();
  if (!native) return null;
  return {
    getSwapDeposit() {
      return readNative(async () => {
        await checked(native, "swaps");
        return native.getSwapDeposit();
      });
    },
    async startSwap(target, amountAtoms, gateway) {
      await checked(native, "swaps");
      return native.startSwap(target, amountAtoms, gateway);
    },
    getMainnetPortfolio() {
      return readNative(async () => {
        await checked(native, "walletStorage");
        if (typeof native.getMainnetPortfolio !== "function")
          throw new Error("Mainnet balances need an updated native build on this platform.");
        return native.getMainnetPortfolio();
      });
    },
    getSwapHoldings(target) {
      return readNative(async () => {
        await checked(native, "swaps");
        if (typeof native.getSwapHoldings !== "function")
          throw new Error("Token holdings need an updated native build.");
        return native.getSwapHoldings(target);
      });
    },
    async sellSwapHolding(holdingId, gateway) {
      await checked(native, "swaps");
      if (typeof native.sellSwapHolding !== "function")
        throw new Error("Selling holdings is not available in this build.");
      return native.sellSwapHolding(holdingId, gateway);
    },
    async sweepSwapHolding(holdingId, destination, gateway) {
      if (!__DEV__) throw new Error("The debug sweep is not available in this build.");
      await checked(native, "swaps");
      if (typeof native.sweepSwapHolding !== "function")
        throw new Error("The debug sweep is not available in this build.");
      return native.sweepSwapHolding(holdingId, destination, gateway);
    },
    async startSell(gateway) {
      await checked(native, "swaps");
      return native.startSell(gateway);
    },
    async startPayout(target, gateway) {
      await checked(native, "swaps");
      if (typeof native.startPayout !== "function")
        throw new Error("Buying from the private balance is not available in this build.");
      return native.startPayout(target, gateway);
    },
    async startRecovery(target, gateway) {
      await checked(native, "swaps");
      if (typeof native.startRecovery !== "function")
        throw new Error("Swap recovery is not available in this build.");
      return native.startRecovery(target, gateway);
    },
    async resumeSwap(gateway) {
      await checked(native, "swaps");
      return native.resumeSwap(gateway);
    },
    getSwapStatus(gateway) {
      return readNative(async () => {
        await checked(native, "swaps");
        return native.getSwapStatus(gateway);
      });
    },
    async cancelSwap(gateway) {
      await checked(native, "swaps");
      return native.cancelSwap(gateway);
    },
    lock: () => {
      authorizationGeneration++;
      native.lock();
    },
  };
}

export function getStoredEarnPayoutSigner() {
  const native = nativeModule();
  if (
    !native?.executeEarnPrivatePayout ||
    !native.listEarnPrivatePayoutOperations ||
    !native.resumeEarnPrivatePayoutOperation ||
    !native.cancelEarnPrivatePayoutOperation ||
    !native.readEarnPrivatePayoutSettlement
  )
    return null;
  const execute = native.executeEarnPrivatePayout.bind(native),
    list = native.listEarnPrivatePayoutOperations.bind(native),
    resume = native.resumeEarnPrivatePayoutOperation.bind(native),
    cancel = native.cancelEarnPrivatePayoutOperation.bind(native),
    settlement = native.readEarnPrivatePayoutSettlement.bind(native);
  return {
    async executeEarnPrivatePayout(request: Parameters<typeof execute>[0]) {
      await checked(native, "earnPrivatePayoutExecution");
      return execute(request);
    },
    async listEarnPrivatePayoutOperations(walletId: string) {
      await checked(native, "earnPrivatePayoutExecution");
      return readNative(() => list(walletId));
    },
    async resumeEarnPrivatePayoutOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return resume(walletId, id, revision);
    },
    async cancelEarnPrivatePayoutOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return cancel(walletId, id, revision);
    },
    async readEarnPrivatePayoutSettlement(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return settlement(walletId, id, revision);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export function getStoredEarnLiquiditySigner() {
  const native = nativeModule();
  if (
    !native?.prepareEarnFusionQuote ||
    !native.executeEarnEthereumLiquidity ||
    !native.listEarnEthereumLiquidityOperations ||
    !native.resumeEarnEthereumLiquidityOperation ||
    !native.cancelEarnEthereumLiquidityOperation ||
    !native.cancelPendingEarnEthereumLiquidityOperation ||
    !native.readEarnEthereumLiquiditySettlement
  )
    return null;
  const quote = native.prepareEarnFusionQuote.bind(native),
    execute = native.executeEarnEthereumLiquidity.bind(native),
    list = native.listEarnEthereumLiquidityOperations.bind(native),
    resume = native.resumeEarnEthereumLiquidityOperation.bind(native),
    cancel = native.cancelEarnEthereumLiquidityOperation.bind(native),
    cancelPending = native.cancelPendingEarnEthereumLiquidityOperation.bind(native),
    settlement = native.readEarnEthereumLiquiditySettlement.bind(native);
  return {
    async prepareEarnFusionQuote(request: Parameters<typeof quote>[0]) {
      await checked(native, "earnEthereumLiquidityExecution");
      return quote(request);
    },
    async executeEarnEthereumLiquidity(request: Parameters<typeof execute>[0]) {
      await checked(native, "earnEthereumLiquidityExecution");
      return execute(request);
    },
    async listEarnEthereumLiquidityOperations(walletId: string) {
      await checked(native, "earnEthereumLiquidityExecution");
      return readNative(() => list(walletId));
    },
    async resumeEarnEthereumLiquidityOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnEthereumLiquidityExecution");
      return resume(walletId, id, revision);
    },
    async cancelEarnEthereumLiquidityOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnEthereumLiquidityExecution");
      return cancel(walletId, id, revision);
    },
    async cancelPendingEarnEthereumLiquidityOperation(
      walletId: string,
      id: string,
      revision: number,
    ) {
      await checked(native, "earnEthereumLiquidityExecution");
      return cancelPending(walletId, id, revision);
    },
    async readEarnEthereumLiquiditySettlement(walletId: string, id: string, revision: number) {
      await checked(native, "earnEthereumLiquidityExecution");
      return settlement(walletId, id, revision);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export function getStoredEarnVaultSigner() {
  const native = nativeModule();
  if (
    !native?.executeEarnVault ||
    !native.listEarnVaultOperations ||
    !native.resumeEarnVaultOperation ||
    !native.cancelEarnVaultOperation
  )
    return null;
  const execute = native.executeEarnVault.bind(native),
    list = native.listEarnVaultOperations.bind(native),
    resume = native.resumeEarnVaultOperation.bind(native),
    cancel = native.cancelEarnVaultOperation.bind(native);
  return {
    async executeEarnVault(proposal: import("@/domain/earn/vaultExecution").VaultProposal) {
      await checked(native, "earnVaultExecution");
      return execute(proposal);
    },
    async listEarnVaultOperations(walletId: string) {
      await checked(native, "earnVaultExecution");
      return readNative(() => list(walletId));
    },
    async resumeEarnVaultOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnVaultExecution");
      return resume(walletId, id, revision);
    },
    async cancelEarnVaultOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnVaultExecution");
      return cancel(walletId, id, revision);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export function getStoredEarnSigner() {
  const native = nativeModule();
  if (!native?.getEarnIntent || !native.prepareEarnIntent) return null;
  const get = native.getEarnIntent.bind(native);
  const prepare = native.prepareEarnIntent.bind(native);
  return {
    ...(native.prepareNewEarnDistributionIntent
      ? {
          async prepareNewEarnDistributionIntent(
            walletId: string,
            profile: string,
            budgetAtoms: string,
          ) {
            await checked(native, "earnWallets");
            if (!(await getSignerCapabilities()).earnDepositDistribution)
              throw new WalletUnavailableError();
            return native.prepareNewEarnDistributionIntent!(walletId, profile, budgetAtoms);
          },
        }
      : {}),
    ...(native.selectEarnInvestmentSlot
      ? {
          async selectEarnInvestmentSlot(walletId: string, intentId: string, slot: number) {
            await checked(native, "earnWallets");
            return native.selectEarnInvestmentSlot!(walletId, intentId, slot);
          },
        }
      : {}),
    ...(native.listEarnIntents
      ? {
          async listEarnIntents(walletId: string) {
            await checked(native, "earnWallets");
            return readNative(() => native.listEarnIntents!(walletId));
          },
        }
      : {}),
    ...(native.prepareNewEarnIntent
      ? {
          async prepareNewEarnIntent(walletId: string, profile: string) {
            await checked(native, "earnWallets");
            return native.prepareNewEarnIntent!(walletId, profile);
          },
        }
      : {}),
    ...(native.selectEarnIntent
      ? {
          async selectEarnIntent(walletId: string, intentId: string) {
            await checked(native, "earnWallets");
            return native.selectEarnIntent!(walletId, intentId);
          },
        }
      : {}),
    async getEarnIntent(walletId: string) {
      await checked(native, "earnWallets");
      return readNative(() => get(walletId));
    },
    async prepareEarnIntent(walletId: string, profile: string) {
      await checked(native, "earnWallets");
      return prepare(walletId, profile);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}
export function getStoredEarnBalanceSigner() {
  const native = nativeModule();
  if (!native?.readEarnBalance) return null;
  const read = native.readEarnBalance.bind(native);
  return {
    async readEarnBalance(walletId: string) {
      await checked(native, "earnWallets");
      return read(walletId);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}

export function getStoredEarnDepositSigner() {
  const native = nativeModule();
  if (
    Platform.OS !== "android" ||
    !native?.prepareEarnDeposit ||
    !native.confirmEarnDeposit ||
    !native.getEarnDepositStatus ||
    !native.resumeEarnDeposit ||
    !native.cancelEarnDeposit
  )
    return null;
  const prepare = native.prepareEarnDeposit.bind(native),
    confirm = native.confirmEarnDeposit.bind(native),
    status = native.getEarnDepositStatus.bind(native),
    resume = native.resumeEarnDeposit.bind(native),
    cancel = native.cancelEarnDeposit.bind(native);
  return {
    ...(native.discardEarnDepositDraft
      ? {
          async discardEarnDepositDraft(walletId: string, journeyId: string) {
            await checked(native, "earnDepositJourney");
            return native.discardEarnDepositDraft!(walletId, journeyId);
          },
        }
      : {}),
    async prepareEarnDeposit(
      walletId: string,
      profileId: string,
      budgetAtoms: string,
      draftId: string | null,
    ) {
      await checked(native, "earnDepositJourney");
      if (!(await getSignerCapabilities()).earnDepositDistribution)
        throw new Error(
          "New distributed deposits require the updated native app. Saved deposits remain available.",
        );
      return prepare(walletId, profileId, budgetAtoms, draftId);
    },
    async confirmEarnDeposit(walletId: string, journeyId: string, revision: number) {
      await checked(native, "earnDepositJourney");
      return confirm(walletId, journeyId, revision);
    },
    async getEarnDepositStatus(walletId: string, journeyId: string) {
      await checked(native, "earnDepositJourney");
      return status(walletId, journeyId);
    },
    async resumeEarnDeposit(walletId: string, journeyId: string, revision: number) {
      await checked(native, "earnDepositJourney");
      return resume(walletId, journeyId, revision);
    },
    // Revocation remains available when foreground/capability reads are interrupted.
    async cancelEarnDeposit(walletId: string, journeyId: string, revision: number) {
      return cancel(walletId, journeyId, revision);
    },
  };
}

export function getStoredEarnSponsoredSigner() {
  const native = nativeModule();
  if (
    !native?.prepareEarnSourceQuote ||
    !native.executeEarnSponsored ||
    !native.listEarnSponsoredOperations ||
    !native.resumeEarnSponsoredOperation ||
    !native.cancelEarnSponsoredOperation ||
    !native.readEarnSponsoredSettlement
  )
    return null;
  const quote = native.prepareEarnSourceQuote.bind(native),
    execute = native.executeEarnSponsored.bind(native),
    list = native.listEarnSponsoredOperations.bind(native),
    resume = native.resumeEarnSponsoredOperation.bind(native),
    cancel = native.cancelEarnSponsoredOperation.bind(native),
    settlement = native.readEarnSponsoredSettlement.bind(native);
  return {
    ...(native.executeEarnFundingBatch
      ? {
          async executeEarnFundingBatch(walletId: string, fundingBatchId: string) {
            await checked(native, "earnSponsoredExecution");
            return native.executeEarnFundingBatch!(walletId, fundingBatchId);
          },
        }
      : {}),
    ...(native.registerEarnFundingPlans
      ? {
          async registerEarnFundingPlans(
            walletId: string,
            requests: import("@/domain/earn/sourceFunding").SponsoredRequest[],
          ) {
            await checked(native, "earnSponsoredExecution");
            return native.registerEarnFundingPlans!(walletId, requests);
          },
        }
      : {}),
    ...(native.planPublicFunding
      ? {
          async planPublicFunding(walletId: string, budgetAtoms: string) {
            await checked(native, "earnSponsoredExecution");
            return native.planPublicFunding!(walletId, budgetAtoms);
          },
        }
      : {}),
    ...(native.prepareEarnSourceQuoteForAccount
      ? {
          async prepareEarnSourceQuoteForAccount(
            walletId: string,
            sourceIndex: number,
            amountAtoms: string,
            operationId: string,
            revision: number,
          ) {
            await checked(native, "earnSponsoredExecution");
            return native.prepareEarnSourceQuoteForAccount!(
              walletId,
              sourceIndex,
              amountAtoms,
              operationId,
              revision,
            );
          },
        }
      : {}),
    async prepareEarnSourceQuote(walletId: string, amount: string, id: string, revision: number) {
      await checked(native, "earnSponsoredExecution");
      return quote(walletId, amount, id, revision);
    },
    async executeEarnSponsored(
      request:
        | import("@/domain/earn/sourceFunding").SponsoredRequest
        | import("@/domain/earn/robinhoodExecution").RobinhoodRequest,
    ) {
      await checked(native, "earnSponsoredExecution");
      return execute(request);
    },
    async listEarnSponsoredOperations(walletId: string) {
      await checked(native, "earnSponsoredExecution");
      return readNative(() => list(walletId));
    },
    async resumeEarnSponsoredOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnSponsoredExecution");
      return resume(walletId, id, revision);
    },
    async cancelEarnSponsoredOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnSponsoredExecution");
      return cancel(walletId, id, revision);
    },
    async readEarnSponsoredSettlement(walletId: string, id: string, revision: number) {
      await checked(native, "earnSponsoredExecution");
      return settlement(walletId, id, revision);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}

export function getStoredEarnWithdrawalSigner() {
  const native = nativeModule();
  if (
    !native?.executeEarnWithdrawal ||
    !native.listEarnWithdrawalOperations ||
    !native.resumeEarnWithdrawalOperation ||
    !native.cancelEarnWithdrawalOperation ||
    !native.readEarnWithdrawalSettlement
  )
    return null;
  return {
    async executeEarnWithdrawal(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return native.executeEarnWithdrawal!(walletId, id, revision);
    },
    async listEarnWithdrawalOperations(walletId: string) {
      await checked(native, "earnPrivatePayoutExecution");
      return readNative(() => native.listEarnWithdrawalOperations!(walletId));
    },
    async resumeEarnWithdrawalOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return native.resumeEarnWithdrawalOperation!(walletId, id, revision);
    },
    async cancelEarnWithdrawalOperation(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return native.cancelEarnWithdrawalOperation!(walletId, id, revision);
    },
    async readEarnWithdrawalSettlement(walletId: string, id: string, revision: number) {
      await checked(native, "earnPrivatePayoutExecution");
      return native.readEarnWithdrawalSettlement!(walletId, id, revision);
    },
    lock() {
      authorizationGeneration++;
      native.lock();
    },
  };
}
