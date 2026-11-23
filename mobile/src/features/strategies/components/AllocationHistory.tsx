import { View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { formatWeight, type StrategyHistoryEntry } from "@/domain/strategies";
import { signalAssetInfo } from "@/domain/strategyCopy";
import { revealedUpdates } from "@/domain/strategyProfile";
import colors from "@/theme/colors.json";

const palette = [
  colors.accent,
  colors.violet.DEFAULT,
  "#f5c26b",
  "#86efac",
  "#f9a8d4",
  "#93c5fd",
  "#fdba74",
  "#c4b5fd",
  "#67e8f9",
  "#fca5a5",
];

/** Each revealed update as one bar split by weight, newest first, with a shared colour key. */
export function AllocationHistory({ history }: { history: readonly StrategyHistoryEntry[] }) {
  const updates = revealedUpdates(history).reverse();
  if (updates.length === 0)
    return (
      <Typography variant="rowValue" className="!text-fg-45">
        Allocations appear after the first reveal.
      </Typography>
    );
  // One colour per asset across every bar, in the order assets first appeared.
  const order: string[] = [];
  for (const { entry } of [...updates].reverse())
    for (const asset of entry.assets) {
      const label = signalAssetInfo(asset).label;
      if (!order.includes(label)) order.push(label);
    }
  const color = (label: string) => palette[order.indexOf(label) % palette.length]!;
  return (
    <View className="gap-3">
      {updates.map(({ entry }) => (
        <View key={entry.seq} className="gap-1">
          <Typography variant="micro">Update {entry.seq}</Typography>
          <View
            accessibilityLabel={`Update ${entry.seq}: ${entry.assets
              .map((asset) => `${signalAssetInfo(asset).label} ${formatWeight(asset.weightBps)}`)
              .join(", ")}`}
            className="h-3 flex-row overflow-hidden rounded-full bg-well"
          >
            {[...entry.assets]
              .sort((a, b) => b.weightBps - a.weightBps)
              .map((asset) => (
                <View
                  key={asset.assetId}
                  style={{
                    flex: asset.weightBps,
                    backgroundColor: color(signalAssetInfo(asset).label),
                  }}
                />
              ))}
          </View>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-x-3 gap-y-1">
        {order.map((label) => (
          <View key={label} className="flex-row items-center gap-1">
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: color(label) }} />
            <Typography variant="micro">{label}</Typography>
          </View>
        ))}
      </View>
    </View>
  );
}
