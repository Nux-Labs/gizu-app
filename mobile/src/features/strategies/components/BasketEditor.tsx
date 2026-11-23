import { View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import {
  STRATEGY_STEP_BPS,
  STRATEGY_TOTAL_BPS,
  basketProblem,
  formatWeight,
  type BasketLine,
} from "@/domain/strategies";

const networks: Record<number, string> = { 1: "Ethereum", 4663: "Robinhood", 8453: "Base" };

export function lineKind(line: BasketLine): string {
  const network = networks[line.chainId] ?? `Chain ${line.chainId}`;
  if (line.kind === 1) return `${network} Earn vault`;
  return line.label === "USDC" ? "Cash" : `${network} stock`;
}

/** Weights in 5% steps; the basket is valid only when they add up to 100%. */
export function BasketEditor({
  lines,
  weights,
  onChange,
  disabled = false,
}: {
  lines: readonly BasketLine[];
  weights: readonly number[];
  onChange: (weights: number[]) => void;
  disabled?: boolean;
}) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const problem = basketProblem(weights);
  const step = (i: number, delta: number) =>
    onChange(weights.map((weight, j) => (j === i ? weight + delta : weight)));
  return (
    <View className="gap-2">
      {lines.map((line, i) => (
        <View
          key={`${line.chainId}:${line.kind}:${line.address}`}
          className="flex-row items-center gap-3 rounded-2xl border border-glassBorder bg-glass px-4 py-3"
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Typography variant="rowTitle" numberOfLines={1}>
              {line.label}
            </Typography>
            <Typography variant="micro">{lineKind(line)}</Typography>
          </View>
          <Button
            label="−"
            accessibilityLabel={`Lower ${line.label} by 5%`}
            variant="quiet"
            disabled={disabled || weights[i]! < STRATEGY_STEP_BPS}
            onPress={() => step(i, -STRATEGY_STEP_BPS)}
          />
          <Typography
            variant="rowValue"
            className="w-12 text-center"
            accessibilityLabel={`${line.label} weight ${formatWeight(weights[i]!)}`}
          >
            {formatWeight(weights[i]!)}
          </Typography>
          <Button
            label="+"
            accessibilityLabel={`Raise ${line.label} by 5%`}
            variant="quiet"
            disabled={disabled || total >= STRATEGY_TOTAL_BPS}
            onPress={() => step(i, STRATEGY_STEP_BPS)}
          />
        </View>
      ))}
      <Typography
        variant="micro"
        accessibilityLiveRegion="polite"
        className={problem ? "!text-danger" : ""}
      >
        {problem ??
          `Total ${formatWeight(total)}. Only these percentages are shared, never amounts.`}
      </Typography>
    </View>
  );
}
