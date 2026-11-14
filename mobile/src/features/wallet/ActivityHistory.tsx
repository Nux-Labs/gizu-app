import { useState } from "react";
import { View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, CircleCheck, CircleX } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { Choice } from "@/components/molecules/Choice";
import { HoldingDetails } from "@/components/molecules/HoldingDetails";
import { Surface } from "@/components/molecules/Surface";
import { swapDirection } from "@/domain/swap";
import { holdingAmount } from "@/domain/wallet/amounts";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import colors from "@/theme/colors.json";

type Entry = MainnetPortfolioSnapshot["history"][number];
type Filter = "all" | "buy" | "sell";
const day = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });
const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });

/** Local swap records only. Buy records do not contain token decimals or a reliable quantity. */
export function ActivityHistory({ entries }: { entries: Entry[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const filtered = entries
    .filter((item) => filter === "all" || item.direction === filter)
    .slice()
    .sort((a, b) => b.recordedAt - a.recordedAt);
  const groups = new Map<string, Entry[]>();
  for (const entry of filtered) {
    const date = day.format(new Date(entry.recordedAt));
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  return (
    <View className="gap-5">
      <View
        className="flex-row gap-2"
        accessibilityRole="radiogroup"
        accessibilityLabel="Activity filter"
      >
        {(
          [
            ["all", "All"],
            ["buy", "Buys"],
            ["sell", "Sells"],
          ] as const
        ).map(([value, label]) => (
          <Choice
            key={value}
            label={label}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </View>
      {!filtered.length && (
        <Typography variant="caption" className="py-6 text-center">
          No swaps match this filter.
        </Typography>
      )}
      {[...groups].map(([date, items]) => (
        <View key={date} className="gap-3">
          <Typography variant="label11">{date}</Typography>
          {items.map((item) => {
            const done = item.phase === "COMPLETE";
            const sell = item.direction === "sell";
            const Icon = sell ? ArrowUpRight : ArrowDownLeft;
            const Status = done ? CircleCheck : CircleX;
            const color = done ? colors.accent : colors.fg["45"];
            return (
              <Surface key={item.operationId}>
                <View className="gap-3 p-4">
                  <View className="flex-row items-center gap-3">
                    <View
                      className={`h-12 w-12 items-center justify-center rounded-2xl ${sell ? "bg-violet/10" : "bg-neon/10"}`}
                    >
                      <Icon size={22} color={sell ? colors.violet.soft : colors.accent} />
                    </View>
                    <View className="min-w-0 flex-1 gap-1">
                      <Typography variant="cardTitle" numberOfLines={1}>
                        {sell ? (done ? "Sold" : "Sell") : done ? "Bought" : "Buy"} {item.symbol}
                      </Typography>
                      <Typography variant="micro">
                        {swapDirection(item.direction, item.symbol)}
                      </Typography>
                    </View>
                    <View className="items-end gap-1.5">
                      <Status size={17} color={color} />
                      <Typography variant="micro">
                        {time.format(new Date(item.recordedAt))}
                      </Typography>
                    </View>
                  </View>
                  <View className="flex-row items-center justify-between border-t border-cardEdge pt-3">
                    <Typography variant="micro" style={{ color }}>
                      {done ? "Completed" : "Cancelled"}
                    </Typography>
                    <Typography variant="micro">
                      {sell && item.completionTarget === "confidential"
                        ? "Private USDC"
                        : sell
                          ? "Monad"
                          : "Robinhood"}
                    </Typography>
                  </View>
                  {sell && done && (
                    <Typography variant="rowValue">
                      {item.completionTarget === "confidential"
                        ? `Credited ${holdingAmount(item.privateCreditedAtoms ?? item.receivedAtoms, 6)} USDC to confidential cash`
                        : `Returned ${holdingAmount(item.receivedAtoms, 6)} USDC on Monad`}
                    </Typography>
                  )}
                  <HoldingDetails
                    label="Transaction details"
                    accessibilityLabel={`Details for ${item.operationId}`}
                  >
                    <Typography variant="micro">
                      {new Date(item.recordedAt).toLocaleString()}
                    </Typography>
                    <Typography variant="caption" selectable>
                      Reference: {item.operationId}
                    </Typography>
                  </HoldingDetails>
                </View>
              </Surface>
            );
          })}
        </View>
      ))}
    </View>
  );
}
