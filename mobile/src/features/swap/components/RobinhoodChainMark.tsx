import { Image } from "react-native";
import robinhoodChain from "../../../../assets/logos/robinhood-chain.png";

/** Robinhood Chain network mark shown on swap tokens in place of a text badge. */
export function RobinhoodChainMark() {
  return (
    <Image
      source={robinhoodChain}
      className="h-6 w-6 rounded-md"
      accessibilityRole="image"
      accessibilityLabel="Robinhood Chain"
      accessibilityIgnoresInvertColors
    />
  );
}
