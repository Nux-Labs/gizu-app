import type { AccountPage } from "@/features/account/pages";
import type { OperationKind } from "@/domain/transactions";
import type { NavigatorScreenParams } from "@react-navigation/native";
export type MainTabParamList = {
  Home: undefined;
  Vaults: undefined;
  /** `sell` opens the sell form with `token` chosen; `request` makes a repeat tap reopen it. */
  Exchange: { mode: "buy" | "sell"; token?: string; request: number } | undefined;
  /** Strategies as a social space: feed, discovery and follows. */
  StrategyHub: undefined;
  Settings: undefined;
};
export type RootStackParamList = {
  ConfidentialWithdrawal: undefined;
  Welcome: undefined;
  RequestAccess: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
  VaultDetail: { id: string };
  OpportunityDetail: { id: string };
  Activity: undefined;
  /** `profileId` opens that vault's deposit with `amount` (USDC, for example "25.5") filled in. */
  Earn:
    | { opportunityId: string }
    | { profileId: import("@/domain/earn/types").EarnProfileId; amount?: string }
    | undefined;
  /** This wallet's own strategy: its profile once published, otherwise the way to publish it. */
  Strategies: undefined;
  /** A strategy's public profile. Deep links pass the id as text; only a positive integer opens. */
  StrategyDetail: { id: number };
  /** One revealed update and its comments. */
  StrategyUpdate: { id: number; seq: number };
  /** The owner changes the strategy's price. */
  StrategyPrice: { strategyId: number };
  /** Without `strategyId` it publishes a new strategy; with it, it seals an update. */
  StrategyPublish: { strategyId?: number } | undefined;
  EarnInvestment: { intentId: string };
  VaultPosition: { profileId: import("@/domain/earn/types").EarnProfileId; opportunityId?: string };
  VaultWithdrawal: {
    profileId: import("@/domain/earn/types").EarnProfileId;
    historyOnly?: boolean;
  };
  Notifications: undefined;
  AccountPage: { page: AccountPage };
  Transaction: { kind?: OperationKind; vaultId?: string; resume?: boolean };
};
