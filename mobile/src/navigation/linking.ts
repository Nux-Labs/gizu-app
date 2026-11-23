import { getStateFromPath, type LinkingOptions } from "@react-navigation/native";
import type { RootStackParamList } from "./types";
import { initialUrl, subscribeToUrls } from "./strategyNotificationLinks";
export function createLinking(signedIn: boolean): LinkingOptions<RootStackParamList> {
  return {
    prefixes: ["gizu://", "gizu-dev://"],
    config: {
      screens: {
        Welcome: "",
        VaultDetail: "vault/:id",
        OpportunityDetail: "opportunity/:id",
        Activity: "activity",
        Earn: "earn",
        EarnInvestment: "earn/investment/:intentId",
        Notifications: "notifications",
        StrategyDetail: { path: "strategy/:id", parse: { id: Number } },
        Main: {
          screens: { Home: "home", Vaults: "vaults", Exchange: "exchange", Settings: "settings" },
        },
      },
    },
    getInitialURL: initialUrl,
    subscribe: subscribeToUrls,
    getStateFromPath(path, options) {
      // No protected destination or unknown input is retained while signed out.
      if (!signedIn) return { routes: [{ name: "Welcome" }] };
      return getStateFromPath(path, options);
    },
  };
}
