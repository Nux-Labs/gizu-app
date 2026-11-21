import type { ReactNode } from "react";
import { Image, type ImageSourcePropType } from "react-native";
import base from "../../../../assets/logos/base.png";
import robinhoodChain from "../../../../assets/logos/robinhood-chain.png";

// Bundled with the app, so network marks render without a logo host.
const marks: Record<number, { source: ImageSourcePropType; label: string }> = {
  4663: { source: robinhoodChain, label: "Robinhood Chain" },
  8453: { source: base, label: "Base" },
};

/** Network mark shown on swap tokens; chains without a bundled mark render [fallback]. */
export function ChainMark({ chainId, fallback }: { chainId: number; fallback: ReactNode }) {
  const mark = marks[chainId];
  if (!mark) return <>{fallback}</>;
  return (
    <Image
      source={mark.source}
      className="h-6 w-6 rounded-md"
      accessibilityRole="image"
      accessibilityLabel={mark.label}
      accessibilityIgnoresInvertColors
    />
  );
}
