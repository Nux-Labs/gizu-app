import { useId } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { avatarColors } from "@/domain/strategyProfile";

/** A generated avatar: two colours from the strategy's signer and the first letter of its name. */
export function StrategyAvatar({
  signer,
  name,
  size = 44,
}: {
  signer: string;
  name: string;
  size?: number;
}) {
  const [from, to] = avatarColors(signer);
  const gradient = `avatar-${useId().replace(/:/g, "")}`;
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Defs>
          <LinearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradient})`} />
      </Svg>
      <Text
        maxFontSizeMultiplier={1.2}
        className="font-medium text-white"
        style={{ fontSize: Math.round(size * 0.42) }}
      >
        {initial}
      </Text>
    </View>
  );
}
