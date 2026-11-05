import { VaultPositionScreen } from "@/features/earn/VaultPositionScreen";
import { ConfidentialWithdrawalScreen } from "@/features/wallet/ConfidentialWithdrawalScreen";
import { EarnInvestmentScreen } from "@/features/earn/EarnInvestmentScreen";
import { UnavailableScreen } from "./UnavailableScreen";
import { AccountPageScreen } from "@/features/account/AccountPageScreen";
import { NotificationsScreen } from "@/features/notifications/NotificationsScreen";
import { TransactionScreen } from "@/features/transactions/TransactionScreen";
import { RequestAccessScreen } from "@/features/access/RequestAccessScreen";
import { VaultDetailScreen } from "@/features/investments/VaultDetailScreen";
import { ActivityScreen } from "@/features/investments/ActivityScreen";
import { OpportunityDetailScreen } from "@/features/opportunities/OpportunityDetailScreen";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useSession } from "@/application/SessionProvider";
import { WelcomeScreen } from "@/features/access/WelcomeScreen";
import { MainTabs } from "./MainTabs";
import { EarnScreen } from "@/features/earn/EarnScreen";
import type { RootStackParamList } from "./types";
import { durations } from "@/theme/motion";
const Stack = createNativeStackNavigator<RootStackParamList>();
export function RootNavigator() {
  const { session } = useSession();
  const native = session?.kind === "testnet" || session?.kind === "mainnet";
  return (
    <Stack.Navigator
      initialRouteName={session ? "Main" : "Welcome"}
      // Frontend screens cross-fade in 350 ms (plus a small shift and blur that
      // native stacks cannot express). Fade keeps native gestures and is motion-safe;
      // modals keep their platform sheet transition and swipe-to-dismiss.
      screenOptions={{
        headerShown: false,
        animation: "fade",
        animationDuration: durations.screen,
      }}
    >
      {session ? (
        <Stack.Group navigationKey={session.kind + ":" + session.accountId}>
          <Stack.Screen name="AccountPage" component={AccountPageScreen} />
          <Stack.Screen
            name="ConfidentialWithdrawal"
            component={
              session.kind === "mainnet" ? ConfidentialWithdrawalScreen : UnavailableScreen
            }
          />
          <Stack.Screen
            name="Earn"
            component={native && session.chainId === 143 ? EarnScreen : UnavailableScreen}
          />
          <Stack.Screen
            name="EarnInvestment"
            component={native && session.chainId === 143 ? EarnInvestmentScreen : UnavailableScreen}
          />
          <Stack.Screen
            name="VaultPosition"
            component={native && session.chainId === 143 ? VaultPositionScreen : UnavailableScreen}
          />
          <Stack.Screen name="Notifications" component={NotificationsScreen} />
          <Stack.Screen
            name="Transaction"
            component={TransactionScreen}
            options={{ presentation: "modal", animation: "default" }}
          />
          <Stack.Screen
            name="VaultDetail"
            component={native ? UnavailableScreen : VaultDetailScreen}
            options={{ title: "Vault details" }}
          />
          <Stack.Screen
            name="OpportunityDetail"
            component={OpportunityDetailScreen}
            options={{ title: "Vault details" }}
          />
          <Stack.Screen
            name="Activity"
            component={ActivityScreen}
            options={{ title: "Activity" }}
          />
          <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        </Stack.Group>
      ) : (
        <Stack.Group navigationKey="guest">
          <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ title: "Gizu" }} />
          <Stack.Screen
            name="RequestAccess"
            component={RequestAccessScreen}
            options={{ presentation: "modal", animation: "default" }}
          />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
}
