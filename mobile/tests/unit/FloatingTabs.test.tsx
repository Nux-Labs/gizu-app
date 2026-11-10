import { fireEvent, render, screen, userEvent } from "@testing-library/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text } from "react-native";
import { FloatingTabs } from "@/navigation/FloatingTabs";

const Tabs = createBottomTabNavigator();
function Page() {
  return <Text>Page content</Text>;
}

test("selection follows accepted navigation and preserves long-press events", async () => {
  const blocked = jest.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const longPress = jest.fn();
  render(
    <SafeAreaProvider>
      <NavigationContainer>
        <Tabs.Navigator
          tabBar={(props) => <FloatingTabs {...props} />}
          screenOptions={{ headerShown: false }}
        >
          <Tabs.Screen name="Home" component={Page} />
          <Tabs.Screen name="Vaults" component={Page} listeners={{ tabLongPress: longPress }} />
          <Tabs.Screen name="Exchange" component={Page} />
          <Tabs.Screen name="Settings" component={Page} listeners={{ tabPress: blocked }} />
        </Tabs.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>,
  );
  for (const [index, name] of ["Home", "Earn", "Swap", "Settings"].entries()) {
    fireEvent(screen.getByRole("button", { name: `${name} tab` }), "layout", {
      nativeEvent: { layout: { x: 8 + 56 * index, y: 8, width: 56, height: 48 } },
    });
  }
  await userEvent.press(screen.getByRole("button", { name: "Settings tab" }));
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Home tab", selected: true })).toBeVisible();
  for (const name of ["Earn", "Swap", "Home", "Earn", "Earn"]) {
    await userEvent.press(screen.getByRole("button", { name: `${name} tab` }));
    expect(screen.getByRole("button", { name: `${name} tab`, selected: true })).toBeVisible();
  }
  fireEvent(screen.getByRole("button", { name: "Earn tab" }), "longPress");
  expect(longPress).toHaveBeenCalledTimes(1);
  // Relayout must not change the selected destination.
  fireEvent(screen.getByRole("button", { name: "Earn tab" }), "layout", {
    nativeEvent: { layout: { x: 70, y: 8, width: 60, height: 48 } },
  });
  expect(screen.getByRole("button", { name: "Earn tab", selected: true })).toBeVisible();
});
