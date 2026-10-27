import { useContext, useEffect, useRef, useState } from "react";
import { Text, View, Pressable, type LayoutRectangle } from "react-native";
import Animated, {
  Extrapolation,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { House, PieChart, ArrowLeftRight, Settings } from "lucide-react-native";
import {
  BottomTabBarHeightCallbackContext,
  type BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import colors from "@/theme/colors.json";
import { springs } from "@/theme/motion";

const icons = { Home: House, Vaults: PieChart, Exchange: ArrowLeftRight, Settings };
const titles = { Home: "Home", Vaults: "Vaults", Exchange: "Swap", Settings: "Settings" };
/** Frontend BottomNav enters from `y: 60` with a fade. */
const ENTRANCE_OFFSET = 60;

function useEntranceStyle(reduceMotion: boolean) {
  const offset = useSharedValue(reduceMotion ? 0 : ENTRANCE_OFFSET);
  useEffect(() => {
    // The entrance targets the settled position once; reduced motion snaps there.
    offset.value = reduceMotion ? 0 : withSpring(0, springs.navEnter);
    return () => cancelAnimation(offset);
  }, [offset, reduceMotion]);
  return useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [ENTRANCE_OFFSET, 0], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: offset.value }],
  }));
}

function usePillStyle(bounds: LayoutRectangle | undefined, selectedKey: string, reduce: boolean) {
  const previousKey = useRef<string | null>(null);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  useEffect(() => {
    if (!bounds) return;
    // Only accepted navigation slides; mount, relayout and reduced motion snap.
    const slide = !reduce && previousKey.current !== null && previousKey.current !== selectedKey;
    x.value = slide ? withSpring(bounds.x, springs.navPill) : bounds.x;
    y.value = slide ? withSpring(bounds.y, springs.navPill) : bounds.y;
    previousKey.current = selectedKey;
  }, [bounds, selectedKey, reduce, x, y]);
  return useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));
}

export function FloatingTabs({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const reportHeight = useContext(BottomTabBarHeightCallbackContext);
  const reduceMotion = useReducedMotion();
  const [layouts, setLayouts] = useState<Record<string, LayoutRectangle>>({});
  const selectedKey = state.routes[state.index]!.key;
  const bounds = layouts[selectedKey];
  const entranceStyle = useEntranceStyle(reduceMotion);
  const pillStyle = usePillStyle(bounds, selectedKey, reduceMotion);
  return (
    <View
      pointerEvents="box-none"
      onLayout={({ nativeEvent }) => reportHeight?.(nativeEvent.layout.height)}
      className="absolute inset-x-0 bottom-0 bg-transparent pt-3"
      style={{
        paddingBottom: Math.max(insets.bottom, 20),
        paddingHorizontal: Math.max(insets.left, insets.right, 20),
      }}
    >
      <Animated.View
        className="self-center rounded-[28px] border border-glassBorder bg-rail p-1.5"
        style={entranceStyle}
      >
        {/* Keep measured tabs and the absolute pill in the same border-free coordinates. */}
        <View className="relative flex-row gap-1">
          {bounds && (
            <Animated.View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="absolute left-0 top-0 items-center justify-end rounded-[22px] border border-white/5 bg-white/[0.08] pb-1"
              style={[{ width: bounds.width, height: bounds.height }, pillStyle]}
            >
              {/* Kurage active rail marker: a short cyan → violet bar. */}
              <Svg width={18} height={2}>
                <Defs>
                  <LinearGradient id="tab-marker" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor={colors.accent} />
                    <Stop offset="1" stopColor={colors.violet.DEFAULT} />
                  </LinearGradient>
                </Defs>
                <Rect width={18} height={2} rx={1} fill="url(#tab-marker)" />
              </Svg>
            </Animated.View>
          )}
          {state.routes.map((route, index) => {
            const selected = state.index === index;
            const Icon = icons[route.name as keyof typeof icons];
            return (
              <Pressable
                key={route.key}
                onLayout={({ nativeEvent: { layout } }) => {
                  const next = {
                    x: layout.x,
                    y: layout.y,
                    width: layout.width,
                    height: layout.height,
                  };
                  setLayouts((current) => {
                    const previous = current[route.key];
                    return previous &&
                      previous.x === next.x &&
                      previous.y === next.y &&
                      previous.width === next.width &&
                      previous.height === next.height
                      ? current
                      : { ...current, [route.key]: next };
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  descriptors[route.key]!.options.tabBarAccessibilityLabel ?? `${route.name} tab`
                }
                accessibilityState={{ selected }}
                onPress={() => {
                  const event = navigation.emit({
                    type: "tabPress",
                    target: route.key,
                    canPreventDefault: true,
                  });
                  if (!selected && !event.defaultPrevented)
                    navigation.navigate(route.name, route.params);
                }}
                onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
                className="h-14 w-[68px] items-center justify-center gap-1 rounded-[22px]"
              >
                <View
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Icon
                    size={19}
                    color={selected ? colors.neon.DEFAULT : colors.fg["45"]}
                    strokeWidth={selected ? 2.25 : 1.75}
                  />
                </View>
                <Text
                  maxFontSizeMultiplier={1.3}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  className={`font-mono text-[10px] ${selected ? "text-text" : "text-fg-45"}`}
                >
                  {titles[route.name as keyof typeof titles]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>
    </View>
  );
}
