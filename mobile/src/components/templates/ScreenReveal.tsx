import { useContext, useEffect, type PropsWithChildren } from "react";
import { NavigationContext } from "@react-navigation/native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { timing } from "@/theme/motion";

/**
 * Replays a rise-and-settle entrance every time the screen gains focus, so tab
 * switches and returns from a pushed screen feel continuous with the native
 * transition. Without navigation (previews, tests) content is shown as-is.
 */
export function ScreenReveal({ children, className }: PropsWithChildren<{ className?: string }>) {
  const navigation = useContext(NavigationContext);
  const progress = useSharedValue(navigation ? 0 : 1);
  useEffect(() => {
    if (!navigation) return;
    let last = 0;
    const play = () => {
      // Mount and the first focus event arrive together; play once.
      if (Date.now() - last < 250) return;
      last = Date.now();
      progress.value = 0;
      progress.value = withTiming(1, timing.reveal);
    };
    if (navigation.isFocused()) play();
    return navigation.addListener("focus", play);
  }, [navigation, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.25 + 0.75 * progress.value,
    transform: [
      { translateY: (1 - progress.value) * 22 },
      { scale: 0.975 + 0.025 * progress.value },
    ],
  }));
  return (
    <Animated.View className={className} style={style}>
      {children}
    </Animated.View>
  );
}
