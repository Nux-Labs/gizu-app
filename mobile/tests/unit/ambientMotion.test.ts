import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook } from "@testing-library/react-native";
import { setAmbientMotion, useAmbientMotion } from "@/storage/ambientMotion";

test("pausing the mascot updates subscribers and persists on the device", async () => {
  const { result } = renderHook(() => useAmbientMotion());
  expect(result.current).toBe(true);
  act(() => setAmbientMotion(false));
  expect(result.current).toBe(false);
  expect(await AsyncStorage.getItem("gizu:ambient-motion:v1")).toBe("off");
  act(() => setAmbientMotion(true));
  expect(result.current).toBe(true);
});
