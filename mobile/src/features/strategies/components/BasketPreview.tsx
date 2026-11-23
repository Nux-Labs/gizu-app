import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { formatWeight, type BasketLine } from "@/domain/strategies";

const networks: Record<number, string> = { 1: "Ethereum", 4663: "Robinhood", 8453: "Base" };

function lineKind(line: BasketLine): string {
  const network = networks[line.chainId] ?? `Chain ${line.chainId}`;
  if (line.kind === 1) return `${network} Earn vault`;
  return line.label === "USDC" ? "Cash" : `${network} stock`;
}

/** The weights a strategy will seal, read from the portfolio; nothing here is editable. */
export function BasketPreview({
  lines,
  weights,
}: {
  lines: readonly BasketLine[];
  weights: readonly number[];
}) {
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
          <Typography
            variant="rowValue"
            accessibilityLabel={`${line.label} weight ${formatWeight(weights[i]!)}`}
          >
            {formatWeight(weights[i]!)}
          </Typography>
        </View>
      ))}
    </View>
  );
}
