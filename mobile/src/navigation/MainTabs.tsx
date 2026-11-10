import { AccountScreen } from "@/features/account/AccountScreen";
import { PortfolioScreen } from "@/features/investments/PortfolioScreen";
import { VaultsScreen } from "@/features/investments/VaultsScreen";
import { NativeSwapScreen } from "@/features/swap/NativeSwapScreen";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { FloatingTabs } from "./FloatingTabs";
import type { MainTabParamList } from "./types";
const Tabs = createBottomTabNavigator<MainTabParamList>();
export function MainTabs() {
  return (
    <Tabs.Navigator
      tabBar={(props) => <FloatingTabs {...props} />}
      backBehavior="initialRoute"
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="Home" component={PortfolioScreen} />
      <Tabs.Screen name="Vaults" component={VaultsScreen} />
      <Tabs.Screen name="Exchange" component={NativeSwapScreen} />
      <Tabs.Screen name="Settings" component={AccountScreen} />
    </Tabs.Navigator>
  );
}
