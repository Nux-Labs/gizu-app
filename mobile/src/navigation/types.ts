import type { AccountPage } from "@/features/account/pages";
import type { OperationKind } from "@/domain/transactions";
import type { NavigatorScreenParams } from "@react-navigation/native";
export type MainTabParamList = {
  Home: undefined;
  Vaults: undefined;
  /** `sell` opens the sell form with `token` chosen; `request` makes a repeat tap reopen it. */
  Exchange: { mode: "buy" | "sell"; token?: string; request: number } | undefined;
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
  Earn: { opportunityId: string } | undefined;
  EarnInvestment: { intentId: string };
  VaultPosition: { profileId: import("@/domain/earn/types").EarnProfileId; opportunityId?: string };
  VaultWithdrawal: { profileId: import("@/domain/earn/types").EarnProfileId };
  Notifications: undefined;
  AccountPage: { page: AccountPage };
  Transaction: { kind?: OperationKind; vaultId?: string; resume?: boolean };
};
