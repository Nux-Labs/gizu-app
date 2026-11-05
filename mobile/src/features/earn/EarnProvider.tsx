import { createEarnDepositService } from "@/services/earn/depositJourney";
import type { EarnDepositService } from "@/domain/earn/depositJourney";
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
import { useFundingWallet } from "@/features/wallet/WalletProvider";
import { createEarnWalletService } from "@/services/wallet/earnWallets";
import type {
  EarnProfileId,
  EarnWalletService,
  EarnWalletState,
  EarnIntent,
  EarnPreflightService,
  EarnPrivateBalanceService,
} from "@/domain/earn/types";
import { createEarnPrivateBalanceService } from "@/services/earn/privateBalance";
import { earnPreflightService } from "@/services/earn/preflight";
import { earnVaultExecutionService } from "@/services/earn/vaultExecution";
import type { EarnVaultExecutionService } from "@/domain/earn/vaultExecution";
import type { EarnSourceFundingService } from "@/domain/earn/sourceFunding";
import type { EarnLiquidityService } from "@/domain/earn/ethereumLiquidity";
import type { EarnPayoutService } from "@/domain/earn/privatePayout";
import { earnPayoutService } from "@/services/earn/privatePayout";
import type { EarnRobinhoodService } from "@/domain/earn/robinhoodExecution";
import { earnRobinhoodService } from "@/services/earn/robinhoodExecution";
import { earnLiquidityService } from "@/services/earn/ethereumLiquidity";
import { earnSourceFundingService } from "@/services/earn/sourceFunding";

function useEarnController(
  injected?: EarnWalletService,
  injectedPreflight?: EarnPreflightService,
  injectedPrivateBalance?: EarnPrivateBalanceService,
  injectedVault?: EarnVaultExecutionService,
  injectedSource?: EarnSourceFundingService,
  injectedLiquidity?: EarnLiquidityService,
  injectedPayout?: EarnPayoutService,
  injectedRobinhood?: EarnRobinhoodService,
  injectedDeposit?: EarnDepositService,
) {
  const { session } = useFundingWallet();
  const depositJourney = useMemo(
    () => injectedDeposit ?? createEarnDepositService(),
    [injectedDeposit],
  );
  const privateBalance = useMemo(
    () => injectedPrivateBalance ?? createEarnPrivateBalanceService(),
    [injectedPrivateBalance],
  );
  const service = useMemo(() => injected ?? createEarnWalletService(), [injected]);
  const owner = useMemo(
    () => ({ walletId: session.walletId ?? "", address: session.address }),
    [session.walletId, session.address],
  );
  const [cycles, setCycles] = useState<EarnIntent[]>([]);
  const [state, setState] = useState<EarnWalletState | null>(null);
  const [loading, setLoading] = useState(session.chainId === 143);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(0);
  const occupied = useRef(false);
  const refresh = useCallback(async () => {
    if (occupied.current) return;
    const attempt = active.current;
    await Promise.resolve();
    if (active.current !== attempt) return;
    setLoading(true);
    setMessage("");
    try {
      const next = await service.load(owner);
      if (active.current === attempt) setState(next);
      if (service.list) {
        const rows = await service.list(owner);
        if (active.current === attempt) setCycles(rows);
      }
    } catch (error) {
      if (active.current === attempt) {
        setState(null);
        setMessage(error instanceof Error ? error.message : "Could not check saved earn intent.");
      }
    } finally {
      if (active.current === attempt) setLoading(false);
    }
  }, [service, owner]);
  useEffect(() => {
    const attempt = ++active.current;
    if (session.chainId === 143)
      void Promise.resolve().then(() => {
        if (active.current === attempt) return refresh();
      });
    return () => {
      active.current = attempt + 1;
      service.cancel();
    };
  }, [refresh, service, session.chainId]);
  const prepare = useCallback(
    async (profile: EarnProfileId) => {
      if (
        occupied.current ||
        loading ||
        !state ||
        ("intentId" in state && state.status !== "recoveryRequired") ||
        session.chainId !== 143
      )
        return;
      occupied.current = true;
      setBusy(true);
      setMessage("");
      const attempt = active.current;
      try {
        const next = await service.prepare(owner, profile);
        if (active.current === attempt) setState(next);
      } catch (error) {
        // Creation may have committed before cancellation, crash or bridge failure.
        // Re-read native storage before offering another allocation attempt.
        if (active.current === attempt) {
          const text = error instanceof Error ? error.message : "Wallet preparation stopped.";
          try {
            const saved = await service.load(owner);
            if (active.current === attempt) {
              setState(saved);
              setMessage(text);
            }
          } catch {
            if (active.current === attempt) {
              setState(null);
              setMessage(text + " Check saved intent before retrying.");
            }
          }
        }
      } finally {
        occupied.current = false;
        if (active.current === attempt) setBusy(false);
      }
    },
    [loading, state, session.chainId, service, owner],
  );
  const changeCycle = async (task: () => Promise<EarnIntent>) => {
    if (occupied.current || loading || session.chainId !== 143) return;
    occupied.current = true;
    const attempt = active.current;
    setBusy(true);
    setMessage("");
    try {
      const next = await task();
      if (active.current === attempt) setState(next);
      if (service.list) {
        const rows = await service.list(owner);
        if (active.current === attempt) setCycles(rows);
      }
    } catch (error) {
      if (active.current === attempt)
        setMessage(error instanceof Error ? error.message : "Earn cycle unavailable.");
    } finally {
      occupied.current = false;
      if (active.current === attempt) setBusy(false);
    }
  };
  return {
    cycles,
    depositJourney,
    prepareNew: service.prepareNew
      ? (profile: EarnProfileId) => changeCycle(() => service.prepareNew!(owner, profile))
      : undefined,
    prepareDistribution: service.prepareDistribution
      ? (profile: EarnProfileId, budgetAtoms: string) =>
          changeCycle(() => service.prepareDistribution!(owner, profile, budgetAtoms))
      : undefined,
    selectInvestmentSlot: service.selectInvestmentSlot
      ? (intentId: string, slot: number) =>
          changeCycle(() => service.selectInvestmentSlot!(owner, intentId, slot))
      : undefined,
    selectCycle: service.select
      ? (intentId: string) => changeCycle(() => service.select!(owner, intentId))
      : undefined,
    state,
    loading,
    busy,
    message,
    refresh,
    prepare,
    privateBalance,
    preflight: injectedPreflight ?? earnPreflightService,
    vaultExecution: injectedVault ?? earnVaultExecutionService,
    sourceFunding: injectedSource ?? earnSourceFundingService,
    liquidity: injectedLiquidity ?? earnLiquidityService,
    payout: injectedPayout ?? earnPayoutService,
    robinhood: injectedRobinhood ?? earnRobinhoodService,
  };
}
const EarnContext = createContext<ReturnType<typeof useEarnController> | null>(null);
export function EarnProvider({
  service,
  preflight,
  privateBalance,
  vaultExecution,
  sourceFunding,
  liquidity,
  payout,
  robinhood,
  depositJourney,
  children,
}: PropsWithChildren<{
  service?: EarnWalletService;
  preflight?: EarnPreflightService;
  privateBalance?: EarnPrivateBalanceService;
  vaultExecution?: EarnVaultExecutionService;
  sourceFunding?: EarnSourceFundingService;
  liquidity?: EarnLiquidityService;
  payout?: EarnPayoutService;
  robinhood?: EarnRobinhoodService;
  depositJourney?: EarnDepositService;
}>) {
  const value = useEarnController(
    service,
    preflight,
    privateBalance,
    vaultExecution,
    sourceFunding,
    liquidity,
    payout,
    robinhood,
    depositJourney,
  );
  return <EarnContext.Provider value={value}>{children}</EarnContext.Provider>;
}
export function useEarn() {
  const value = useContext(EarnContext);
  if (!value) throw new Error("EarnProvider required.");
  return value;
}
