import type { ComponentProps, PropsWithChildren } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
// Raised glass card (Kurage composer): translucent fill over the grid, hairline edge and a
// lit top rim. No backdrop blur on native.
export function Surface({
  children,
  className = "",
  layout,
}: PropsWithChildren<{
  className?: string;
  layout?: ComponentProps<typeof Animated.View>["layout"];
}>) {
  const surfaceClass = `overflow-hidden rounded-card border border-cardEdge bg-card ${className}`;
  const rim = <View pointerEvents="none" className="absolute inset-x-6 top-0 h-px bg-white/10" />;
  if (layout)
    return (
      <Animated.View layout={layout} className={surfaceClass}>
        {rim}
        {children}
      </Animated.View>
    );
  return (
    <View className={surfaceClass}>
      {rim}
      {children}
    </View>
  );
}
