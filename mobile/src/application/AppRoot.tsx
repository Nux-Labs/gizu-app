import {
  MainnetWalletProvider,
  type MainnetPortfolioService,
} from "@/features/wallet/MainnetWalletProvider";
import { OpportunityServiceContext } from "@/features/opportunities/useOpportunities";
import { opportunityService as defaultOpportunityService } from "@/services/opportunities";
import type { OpportunityService } from "@/domain/opportunities";
import type { WalletTransferService } from "@/domain/wallet/types";
import { WalletProvider } from "@/features/wallet/WalletProvider";
import type { WalletBalanceService } from "@/services/wallet/balance";
import type { ReactNode } from "react";
import { AccountProvider, type AccountDependencies } from "@/features/account/AccountProvider";
import { NotificationProvider } from "@/features/notifications/NotificationProvider";
import { emptyNotificationService, type NotificationService } from "@/services/notifications";
import { TransactionProvider } from "@/features/transactions/TransactionProvider";
import type { TransactionService } from "@/services/transactions";
import { EarlyAccessProvider } from "@/features/access/EarlyAccessProvider";
import type { EarlyAccessService } from "@/services/earlyAccess";
import { InvestmentProvider } from "@/features/investments/InvestmentProvider";
import type { InvestmentService } from "@/services/investments";
import {
  DarkTheme,
  NavigationContainer,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { analytics, type AnalyticsService } from "@/services/analytics";
import { useScreenTracking } from "@/navigation/useScreenTracking";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { RootNavigator } from "@/navigation/RootNavigator";
import colors from "@/theme/colors.json";
import { SessionProvider, useSession } from "./SessionProvider";
import { type AccessService, type WalletSession } from "@/services/access";
import { createLinking } from "@/navigation/linking";
import { StrategyPushSync } from "@/features/strategies/StrategyPushSync";
import type { RootStackParamList } from "@/navigation/types";
import { ToastHost } from "@/components/organisms/toast/ToastHost";
import { ErrorBoundary } from "./ErrorBoundary";
import { EarnProvider } from "@/features/earn/EarnProvider";
import type { EarnVaultExecutionService } from "@/domain/earn/vaultExecution";
import type { EarnPayoutService } from "@/domain/earn/privatePayout";
import type { EarnRobinhoodService } from "@/domain/earn/robinhoodExecution";
import type { EarnLiquidityService } from "@/domain/earn/ethereumLiquidity";
import type { EarnSourceFundingService } from "@/domain/earn/sourceFunding";
import type {
  EarnWalletService,
  EarnPreflightService,
  EarnPrivateBalanceService,
} from "@/domain/earn/types";
const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.ink,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};
function AppNavigation({
  analyticsService,
  investmentService,
  opportunityService = defaultOpportunityService,
  transactionService,
  accountDependencies,
  notificationService,
  renderNativeSession,
  walletBalanceService,
  mainnetPortfolioService,
  walletTransferService,
  earnWalletService,
  earnPreflightService,
  earnPrivateBalanceService,
  earnVaultService,
  earnSourceService,
  earnLiquidityService,
  earnPayoutService,
  earnRobinhoodService,
}: {
  analyticsService: AnalyticsService;
  investmentService?: InvestmentService;
  opportunityService?: OpportunityService;
  transactionService?: TransactionService;
  accountDependencies?: AccountDependencies;
  notificationService?: NotificationService;
  renderNativeSession?: (session: WalletSession) => ReactNode;
  walletBalanceService?: WalletBalanceService;
  mainnetPortfolioService?: MainnetPortfolioService;
  walletTransferService?: WalletTransferService;
  earnWalletService?: EarnWalletService;
  earnPreflightService?: EarnPreflightService;
  earnPrivateBalanceService?: EarnPrivateBalanceService;
  earnVaultService?: EarnVaultExecutionService;
  earnSourceService?: EarnSourceFundingService;
  earnLiquidityService?: EarnLiquidityService;
  earnPayoutService?: EarnPayoutService;
  earnRobinhoodService?: EarnRobinhoodService;
}) {
  const { session } = useSession();
  const navigation = useNavigationContainerRef<RootStackParamList>();
  const { onReady, onStateChange } = useScreenTracking(navigation, analyticsService);
  if ((session?.kind === "testnet" || session?.kind === "mainnet") && renderNativeSession)
    return renderNativeSession(session);
  return (
    <NavigationContainer
      key={
        session
          ? `${session.kind}:${session.accountId ?? "default"}:${session.kind !== "demo" ? session.chainId : "demo"}`
          : "guest"
      }
      ref={navigation}
      onReady={onReady}
      onStateChange={onStateChange}
      theme={theme}
      linking={createLinking(!!session)}
    >
      {session?.kind === "mainnet" ? (
        <MainnetWalletProvider session={session} service={mainnetPortfolioService}>
          <EarnProvider
            service={earnWalletService}
            preflight={earnPreflightService}
            privateBalance={earnPrivateBalanceService}
            vaultExecution={earnVaultService}
            sourceFunding={earnSourceService}
            liquidity={earnLiquidityService}
            payout={earnPayoutService}
            robinhood={earnRobinhoodService}
          >
            <OpportunityServiceContext.Provider value={opportunityService}>
              <AccountProvider {...accountDependencies}>
                <NotificationProvider service={emptyNotificationService}>
                  <StrategyPushSync />
                  <RootNavigator />
                </NotificationProvider>
              </AccountProvider>
            </OpportunityServiceContext.Provider>
          </EarnProvider>
        </MainnetWalletProvider>
      ) : session?.kind === "testnet" ? (
        <WalletProvider
          session={session}
          balance={walletBalanceService}
          transfers={walletTransferService}
        >
          <EarnProvider
            service={earnWalletService}
            preflight={earnPreflightService}
            privateBalance={earnPrivateBalanceService}
            vaultExecution={earnVaultService}
            sourceFunding={earnSourceService}
            liquidity={earnLiquidityService}
            payout={earnPayoutService}
            robinhood={earnRobinhoodService}
          >
            <OpportunityServiceContext.Provider value={opportunityService}>
              <AccountProvider {...accountDependencies}>
                <NotificationProvider service={emptyNotificationService}>
                  <RootNavigator />
                </NotificationProvider>
              </AccountProvider>
            </OpportunityServiceContext.Provider>
          </EarnProvider>
        </WalletProvider>
      ) : session ? (
        <InvestmentProvider service={investmentService}>
          <TransactionProvider service={transactionService}>
            <AccountProvider {...accountDependencies}>
              <NotificationProvider service={notificationService}>
                <RootNavigator />
              </NotificationProvider>
            </AccountProvider>
          </TransactionProvider>
        </InvestmentProvider>
      ) : (
        <RootNavigator />
      )}
    </NavigationContainer>
  );
}
function SessionToastHost() {
  const { session } = useSession();
  const key = session
    ? `${session.kind}:${session.accountId ?? "default"}:${session.kind === "demo" ? "demo" : session.address}`
    : "guest";
  return <ToastHost key={key} />;
}
export function AppRoot({
  analyticsService = analytics,
  accessService,
  earlyAccessService,
  investmentService,
  opportunityService = defaultOpportunityService,
  transactionService,
  accountDependencies,
  notificationService,
  renderNativeSession,
  walletBalanceService,
  mainnetPortfolioService,
  walletTransferService,
  earnWalletService,
  earnPreflightService,
  earnPrivateBalanceService,
  earnVaultService,
  earnSourceService,
  earnLiquidityService,
  earnPayoutService,
  earnRobinhoodService,
}: {
  analyticsService?: AnalyticsService;
  accessService?: AccessService;
  earlyAccessService?: EarlyAccessService;
  investmentService?: InvestmentService;
  opportunityService?: OpportunityService;
  transactionService?: TransactionService;
  accountDependencies?: AccountDependencies;
  notificationService?: NotificationService;
  renderNativeSession?: (session: WalletSession) => ReactNode;
  walletBalanceService?: WalletBalanceService;
  mainnetPortfolioService?: MainnetPortfolioService;
  walletTransferService?: WalletTransferService;
  earnWalletService?: EarnWalletService;
  earnPreflightService?: EarnPreflightService;
  earnPrivateBalanceService?: EarnPrivateBalanceService;
  earnVaultService?: EarnVaultExecutionService;
  earnSourceService?: EarnSourceFundingService;
  earnLiquidityService?: EarnLiquidityService;
  earnPayoutService?: EarnPayoutService;
  earnRobinhoodService?: EarnRobinhoodService;
}) {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <SessionProvider accessService={accessService}>
          <EarlyAccessProvider service={earlyAccessService}>
            <StatusBar style="light" />
            <AppNavigation
              analyticsService={analyticsService}
              earnWalletService={earnWalletService}
              earnPreflightService={earnPreflightService}
              earnPrivateBalanceService={earnPrivateBalanceService}
              earnVaultService={earnVaultService}
              earnSourceService={earnSourceService}
              earnLiquidityService={earnLiquidityService}
              earnPayoutService={earnPayoutService}
              earnRobinhoodService={earnRobinhoodService}
              walletTransferService={walletTransferService}
              walletBalanceService={walletBalanceService}
              mainnetPortfolioService={mainnetPortfolioService}
              renderNativeSession={renderNativeSession}
              accountDependencies={accountDependencies}
              notificationService={notificationService}
              opportunityService={opportunityService}
              investmentService={investmentService}
              transactionService={transactionService}
            />
            <SessionToastHost />
          </EarlyAccessProvider>
        </SessionProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
