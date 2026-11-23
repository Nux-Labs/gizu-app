import { Pressable, View } from "react-native";
import { Lock, Tag } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import { formatPrice, type FeedEvent } from "@/domain/strategies";
import { agoText } from "@/domain/strategyProfile";
import colors from "@/theme/colors.json";
import { UpdateCard } from "./UpdateCard";

/** One feed event: a sealed update (weights still hidden), a reveal, or a price change. */
export function FeedEventCard({
  event,
  nowMs,
  onOpenStrategy,
  onOpenUpdate,
}: {
  event: FeedEvent;
  nowMs: number;
  onOpenStrategy: (id: number) => void;
  onOpenUpdate: (id: number, seq: number) => void;
}) {
  if (event.kind === "revealed")
    return (
      <UpdateCard
        strategyId={event.strategyId}
        strategyName={event.strategyName}
        seq={event.seq}
        at={event.at}
        assets={event.assets}
        previous={event.previousAssets}
        periodReturnBps={event.periodReturnBps}
        likes={event.likes}
        comments={event.comments}
        liked={event.liked}
        nowMs={nowMs}
        showStrategy
        onOpenStrategy={() => onOpenStrategy(event.strategyId)}
        onOpenComments={() => onOpenUpdate(event.strategyId, event.seq)}
      />
    );
  const Icon = event.kind === "sealed" ? Lock : Tag;
  const text =
    event.kind === "sealed"
      ? `sealed update ${event.seq}. Its weights stay hidden until the embargo ends.`
      : `changed its price to ${formatPrice(event.monthlyPriceAtoms)} a month and ${formatPrice(event.signalPriceAtoms)} per agent signal (was ${formatPrice(event.previous.monthlyPriceAtoms)} and ${formatPrice(event.previous.signalPriceAtoms)}).`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.strategyName} ${text}`}
      onPress={() => onOpenStrategy(event.strategyId)}
      className="flex-row gap-3 rounded-2xl border border-glassBorder px-4 py-3"
    >
      <View className="pt-0.5">
        <Icon size={16} color={colors.fg["45"]} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Typography variant="rowValue">
          <Typography variant="rowTitle">{event.strategyName}</Typography> {text}
        </Typography>
        <Typography variant="micro">{agoText(event.at, nowMs)}</Typography>
      </View>
    </Pressable>
  );
}
