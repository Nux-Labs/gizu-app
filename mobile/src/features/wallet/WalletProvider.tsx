import { useOptionalMainnetWallet } from "./MainnetWalletProvider";
import { createStoredTransfers } from "@/services/wallet/storedTransfers";
import { AppState } from "react-native";
import { useWalletTransfers } from "./useWalletTransfers";
import { type WalletTransferService } from "@/domain/wallet/types";
import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from "react";
import type { WalletSession } from "@/services/access";
import { monadBalanceService, type WalletBalanceService } from "@/services/wallet/balance";
import { clipboardService } from "@/services/clipboard";
import { useWalletController } from "./useWalletController";
import { monadUsdcBalanceService } from "@/services/wallet/usdcBalance";
import { monadUsdc, monadTestnetMon } from "@/domain/wallet/assets";
import { formatMon, formatUsdc } from "@/domain/wallet/amounts";
import { portfolioUsdcBalance, portfolioPublicUsdcAtoms } from "@/domain/wallet/portfolioValue";

const WalletContext = createContext<
  | (ReturnType<typeof useWalletController> & {
      session: WalletSession;
      asset: typeof monadUsdc | typeof monadTestnetMon;
      transfersAvailable: boolean;
      transfers: ReturnType<typeof useWalletTransfers>;
    })
  | null
>(null);
export function WalletProvider({
  session,
  balance,
  children,
  transfers,
}: PropsWithChildren<{
  session: WalletSession;
  balance?: WalletBalanceService;
  transfers?: WalletTransferService;
}>) {
  const mainnet = session.chainId === 143;
  const asset = mainnet ? monadUsdc : monadTestnetMon;
  const state = useWalletController(
    session.address,
    balance ?? (mainnet ? monadUsdcBalanceService : monadBalanceService),
    clipboardService,
    mainnet ? formatUsdc : formatMon,
  );
  const service = useMemo(() => {
    if (transfers) return transfers;
    if (!session.walletId) throw new Error("Stored wallet identity required");
    return createStoredTransfers(session.walletId);
  }, [session.walletId, transfers]);
  // This service currently authorizes MON transfers on 10143 only. Never run it
  // for the mainnet USDC view, including on foreground/history refresh.
  const operations = useWalletTransfers(session.address, service, state.refresh, !mainnet);
  const { refresh } = operations;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && !mainnet) void refresh();
    });
    return () => subscription.remove();
  }, [refresh, mainnet]);
  return (
    <WalletContext.Provider
      value={{ ...state, session, asset, transfersAvailable: !mainnet, transfers: operations }}
    >
      {children}
    </WalletContext.Provider>
  );
}
export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("WalletProvider is required");
  return value;
}

/** Shared funding view; mainnet balances have the native portfolio provider as their owner. */
export function useFundingWallet() {
  const legacy = useContext(WalletContext);
  const mainnet = useOptionalMainnetWallet();
  if (mainnet) {
    const observed = mainnet.snapshot ? portfolioUsdcBalance(mainnet.snapshot) : null;
    const publicAtoms = mainnet.snapshot ? portfolioPublicUsdcAtoms(mainnet.snapshot) : null;
    return {
      session: mainnet.session,
      balance: publicAtoms !== null ? formatUsdc(publicAtoms) : null,
      depositBalance: observed
        ? {
            balance: formatUsdc(observed.totalAtoms),
            breakdown: {
              privateBalance: formatUsdc(observed.privateAtoms),
              publicBalance: formatUsdc(observed.publicAtoms),
            },
          }
        : null,
      loading: mainnet.loading && mainnet.snapshot === null,
      refreshing: mainnet.loading,
      error: Boolean(mainnet.error) && mainnet.snapshot === null,
      refresh: mainnet.refresh,
      refreshAfterAction: mainnet.refreshAfterAction,
    };
  }
  if (!legacy) throw new Error("Wallet provider required");
  return {
    ...legacy,
    depositBalance: null,
    refreshing: legacy.loading,
    refreshAfterAction: legacy.refresh,
  };
}
