import { AppState } from "react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import type { MainnetWalletSession } from "@/services/access";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { getStoredSigner, getStoredSwapSigner } from "@/services/wallet/nativeBridge";
import {
  portfolioValuationService,
  expirePortfolioValuation,
  type PortfolioValuationService,
} from "@/services/wallet/portfolioValuation";

export function validateMainnetPortfolio(
  value: MainnetPortfolioSnapshot,
  walletId: string | undefined,
) {
  if (
    value.walletId !== walletId ||
    value.chainId !== 143 ||
    value.asset !== "USDC" ||
    value.decimals !== 6
  )
    throw new Error("Invalid mainnet portfolio identity");
  const atoms = (value: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid USDC balance");
    return BigInt(value);
  };
  if (atoms(value.fundingAtoms) + atoms(value.returnAtoms) !== atoms(value.totalAtoms))
    throw new Error("Inconsistent USDC balances");
  const seen = new Set<string>();
  const total = value.accounts.reduce((sum, account) => {
    const address = account.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || seen.has(address))
      throw new Error("Invalid portfolio account");
    seen.add(address);
    return sum + atoms(account.balanceAtoms);
  }, 0n);
  if (total !== atoms(value.totalAtoms)) throw new Error("Inconsistent account balances");
  for (const item of value.history) {
    if (
      item.completionTarget !== undefined &&
      item.completionTarget !== "public" &&
      item.completionTarget !== "confidential"
    )
      throw new Error("Invalid sale completion target");
    if (item.completionTarget !== "confidential") continue;
    const credit = atoms(item.privateCreditedAtoms ?? "");
    if (
      item.direction !== "sell" ||
      credit !== atoms(item.receivedAtoms) ||
      (item.phase === "COMPLETE" ? credit <= 0n : item.phase !== "CANCELLED" || credit !== 0n)
    )
      throw new Error("Invalid private sale credit");
  }
  const assets = [...(value.ownedAssets ?? []), ...(value.positions ?? [])];
  if (assets.length > 4096) throw new Error("Invalid owned portfolio size");
  for (const asset of assets) {
    if (
      !asset.assetId ||
      typeof asset.symbol !== "string" ||
      !asset.symbol ||
      asset.symbol.length > 32 ||
      !Number.isSafeInteger(asset.chainId) ||
      asset.chainId <= 0 ||
      (asset.decimals !== null &&
        (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36)) ||
      typeof asset.complete !== "boolean" ||
      typeof asset.stale !== "boolean" ||
      typeof asset.valuationUnavailable !== "boolean" ||
      !Number.isFinite(asset.checkedAt) ||
      asset.checkedAt < 0
    )
      throw new Error("Invalid owned portfolio asset");
    atoms(asset.observedAtoms);
    if (asset.balanceAtoms !== null) atoms(asset.balanceAtoms);
    if (asset.valueUsdcAtoms !== null) atoms(asset.valueUsdcAtoms);
    if (asset.valueUsdAtoms != null) atoms(asset.valueUsdAtoms);
    if (asset.complete && asset.balanceAtoms === null)
      throw new Error("Missing owned asset balance");
    if (
      "shareDecimals" in asset &&
      asset.shareDecimals !== undefined &&
      asset.shareDecimals !== null &&
      (!Number.isInteger(asset.shareDecimals) ||
        (asset.shareDecimals as number) < 0 ||
        (asset.shareDecimals as number) > 36)
    )
      throw new Error("Invalid native vault decimals");
    if (
      "conversionEstimated" in asset &&
      asset.conversionEstimated !== undefined &&
      typeof asset.conversionEstimated !== "boolean"
    )
      throw new Error("Invalid native vault conversion");
    if ("shareAtoms" in asset && asset.shareAtoms !== null) atoms(asset.shareAtoms as string);
    if ("underlyingAtoms" in asset && asset.underlyingAtoms !== null)
      atoms(asset.underlyingAtoms as string);
    if (
      "observedUnderlyingAtoms" in asset &&
      asset.observedUnderlyingAtoms !== undefined &&
      asset.observedUnderlyingAtoms !== null
    )
      atoms(asset.observedUnderlyingAtoms as string);
  }
  return value;
}

export type MainnetPortfolioService = {
  getMainnetPortfolio(): Promise<MainnetPortfolioSnapshot>;
  getCachedMainnetPortfolio?(): Promise<MainnetPortfolioSnapshot>;
};
function useMainnetState(
  session: MainnetWalletSession,
  service?: MainnetPortfolioService,
  valuation?: PortfolioValuationService,
) {
  const [snapshot, setSnapshot] = useState<MainnetPortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unlockingPrivateBalance, setUnlockingPrivateBalance] = useState(false);
  const [privateBalanceError, setPrivateBalanceError] = useState("");
  const alive = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const unlocking = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const cacheRead = useRef(false);
  const actionRevision = useRef(0);
  const actionRefresh = useRef<Promise<void> | null>(null);
  const readCompletion = useRef<Promise<void> | null>(null);
  const unlockCompletion = useRef<Promise<void> | null>(null);
  const lifetime = useRef(0);
  const foregroundRead = useRef<Promise<void> | null>(null);
  const backgroundRevision = useRef(0);
  const resumeRead = useRef<(() => void) | null>(null);
  const valuator = useMemo(
    () => valuation ?? (service ? undefined : portfolioValuationService),
    [valuation, service],
  );
  useEffect(() => {
    alive.current = true;
    const resume = () => {
      foregroundRead.current = null;
      resumeRead.current?.();
      resumeRead.current = null;
    };
    const pause = () => {
      if (!foregroundRead.current) {
        backgroundRevision.current += 1;
        foregroundRead.current = new Promise<void>((resolve) => {
          resumeRead.current = resolve;
        });
      }
    };
    if (AppState.currentState === "background") pause();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") pause();
      else if (state === "active") resume();
    });
    return () => {
      alive.current = false;
      busy.current = false;
      generation.current += 1;
      lifetime.current += 1;
      controller.current?.abort();
      subscription.remove();
      resume();
    };
  }, []);
  const refresh = useCallback(
    async (quiet = false) => {
      if (busy.current || unlocking.current) return;
      let finishRead!: () => void;
      const completion = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      readCompletion.current = completion;
      busy.current = true;
      const requestGeneration = generation.current;
      const current = () => alive.current && generation.current === requestGeneration;
      const abort = new AbortController();
      controller.current = abort;
      setLoading(!quiet);
      if (!quiet) setError("");
      try {
        const signer = service ?? getStoredSwapSigner();
        if (!signer) throw new Error("Native mainnet portfolio is unavailable in this build.");
        if (!cacheRead.current && signer.getCachedMainnetPortfolio) {
          cacheRead.current = true;
          try {
            const cached = validateMainnetPortfolio(
              await signer.getCachedMainnetPortfolio(),
              session.walletId,
            );
            if (cached.fundingAddress.toLowerCase() !== session.address.toLowerCase())
              throw new Error("Funding account mismatch");
            if (current() && cached.checkedAt > 0) setSnapshot(cached);
          } catch {
            // A missing or invalid cache never prevents a fresh native read.
          }
          if (!current()) return;
        }
        const result = validateMainnetPortfolio(
          await signer.getMainnetPortfolio(),
          session.walletId,
        );
        if (result.fundingAddress.toLowerCase() !== session.address.toLowerCase())
          throw new Error("Funding account mismatch");
        if (current()) setSnapshot(result);
        if (valuator && current()) {
          const valued = await valuator.value(result, abort.signal);
          if (current()) setSnapshot(valued);
        }
      } catch (cause) {
        if (current() && !quiet)
          setError(cause instanceof Error ? cause.message : "Mainnet balance unavailable. Retry.");
      } finally {
        if (readCompletion.current === completion) {
          busy.current = false;
          readCompletion.current = null;
        }
        if (current()) setLoading(false);
        finishRead();
      }
    },
    [session.walletId, session.address, service, valuator],
  );
  const refreshAfterAction = useCallback((): Promise<void> => {
    if (!alive.current) return Promise.resolve();
    actionRevision.current += 1;
    // An earlier read cannot overwrite observations collected after a wallet action.
    generation.current += 1;
    controller.current?.abort();
    if (actionRefresh.current) return actionRefresh.current;
    actionRefresh.current = Promise.resolve().then(async () => {
      try {
        let revision;
        let background;
        do {
          // Native reads are coalesced. Wait for the old read/unlock to finish so this
          // request cannot accidentally reuse a balance from before the action.
          while (
            alive.current &&
            (readCompletion.current || unlockCompletion.current || foregroundRead.current)
          )
            await Promise.all([
              readCompletion.current,
              unlockCompletion.current,
              foregroundRead.current,
            ]);
          if (!alive.current) return;
          revision = actionRevision.current;
          background = backgroundRevision.current;
          await refresh(true);
          // Backgrounding may interrupt native work even if foreground resumed before
          // its rejection reached JavaScript. Keep that action update pending.
        } while (
          alive.current &&
          (revision !== actionRevision.current || background !== backgroundRevision.current)
        );
      } finally {
        actionRefresh.current = null;
      }
    });
    return actionRefresh.current;
  }, [refresh]);
  const unlockPrivateBalance = useCallback(async () => {
    if (busy.current || unlocking.current) return;
    const ownerLifetime = lifetime.current;
    const current = () => alive.current && lifetime.current === ownerLifetime;
    let finishUnlock!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishUnlock = resolve;
    });
    unlockCompletion.current = completion;
    unlocking.current = true;
    setUnlockingPrivateBalance(true);
    setPrivateBalanceError("");
    try {
      const signer = getStoredSigner();
      if (!signer) throw new Error("Private balance refresh is unavailable in this build.");
      // Reuse the existing read-only login permission. No spending approval is requested.
      const state = await signer.openWallet();
      if (!current()) return;
      if (state.status !== "ready" || state.walletId !== session.walletId)
        throw new Error("Wallet changed. Sign in again before checking private balances.");
      unlocking.current = false;
      await refresh();
    } catch (cause) {
      if (current())
        setPrivateBalanceError(
          cause instanceof Error ? cause.message : "Could not refresh your private balance. Retry.",
        );
    } finally {
      unlocking.current = false;
      if (current()) setUnlockingPrivateBalance(false);
      if (unlockCompletion.current === completion) unlockCompletion.current = null;
      finishUnlock();
    }
  }, [session.walletId, refresh]);
  useEffect(() => {
    const expiresAt = snapshot?.valuationExpiresAt;
    if (expiresAt === undefined) return;
    const timer = setTimeout(
      () => {
        setSnapshot((previous) =>
          previous?.valuationExpiresAt === expiresAt
            ? expirePortfolioValuation(previous)
            : previous,
        );
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot?.valuationExpiresAt]);
  useEffect(() => {
    void Promise.resolve().then(() => {
      if (alive.current) return refresh();
    });
  }, [refresh]);
  return {
    session,
    snapshot,
    loading,
    error,
    refresh,
    refreshAfterAction,
    unlockingPrivateBalance,
    privateBalanceError,
    unlockPrivateBalance,
  };
}
const Context = createContext<ReturnType<typeof useMainnetState> | null>(null);
export function MainnetWalletProvider({
  session,
  children,
  service,
  valuation,
}: PropsWithChildren<{
  session: MainnetWalletSession;
  service?: MainnetPortfolioService;
  valuation?: PortfolioValuationService;
}>) {
  // Changing wallets discards both the previous snapshot and its request ownership.
  return (
    <SessionPortfolioProvider
      key={`${session.walletId}:${session.address.toLowerCase()}`}
      session={session}
      service={service}
      valuation={valuation}
    >
      {children}
    </SessionPortfolioProvider>
  );
}

function SessionPortfolioProvider({
  session,
  children,
  service,
  valuation,
}: PropsWithChildren<{
  session: MainnetWalletSession;
  service?: MainnetPortfolioService;
  valuation?: PortfolioValuationService;
}>) {
  const value = useMainnetState(session, service, valuation);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useMainnetWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("Mainnet wallet provider required");
  return value;
}

export function useOptionalMainnetWallet() {
  return useContext(Context);
}
