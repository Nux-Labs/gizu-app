import { View } from "react-native";
import { Heart, MessageCircle } from "lucide-react-native";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Typography } from "@/components/atoms/Typography";
import {
  drawdownText,
  formatEmbargo,
  formatPrice,
  strategyReturnText,
  type StrategyCard,
} from "@/domain/strategies";
import { isNewStrategy } from "@/domain/strategyProfile";
import colors from "@/theme/colors.json";
import { StrategyAvatar } from "./StrategyAvatar";

function Tag({ label, tone = "muted" }: { label: string; tone?: "muted" | "accent" | "danger" }) {
  const text = tone === "accent" ? "!text-accent" : tone === "danger" ? "!text-danger" : "";
  return (
    <View className="rounded-full border border-glassBorder px-2 py-0.5">
      <Typography variant="micro" className={text}>
        {label}
      </Typography>
    </View>
  );
}

/** A strategy in a list: who it is, its verified record and how much people engage with it. */
export function StrategyCardRow({
  card,
  mine,
  following,
  nowMs,
  onPress,
}: {
  card: StrategyCard;
  mine: boolean;
  following: boolean;
  nowMs: number;
  onPress: () => void;
}) {
  const seatsLeft = card.seats - card.seatsTaken;
  const drawdown = drawdownText(card);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open strategy ${card.name}`}
      onPress={onPress}
      className="gap-3 rounded-2xl border border-glassBorder bg-glass px-4 py-4"
    >
      <View className="flex-row items-center gap-3">
        <StrategyAvatar signer={card.signer} name={card.name} />
        <View className="min-w-0 flex-1 gap-1">
          <Typography variant="cardTitle" numberOfLines={1}>
            {card.name}
          </Typography>
          <View className="flex-row flex-wrap gap-1.5">
            {mine && <Tag label="Yours" tone="accent" />}
            {!mine && following && <Tag label="Following" />}
            {isNewStrategy(card, nowMs) && <Tag label="New" />}
            {card.broken && <Tag label="Late reveal" tone="danger" />}
          </View>
        </View>
      </View>
      <Typography variant="rowValue">{strategyReturnText(card)}</Typography>
      <Typography variant="micro">
        {[
          drawdown,
          `${card.revealed}/${card.commits} updates revealed`,
          `${formatEmbargo(card.embargoSeconds)} delay`,
          `${formatPrice(card.monthlyPriceAtoms)}/mo`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Typography>
      <View className="flex-row items-center gap-4">
        <View
          className="flex-row items-center gap-1"
          accessibilityLabel={`${card.social.likes} likes`}
        >
          <Heart size={14} color={colors.fg["45"]} />
          <Typography variant="micro">{card.social.likes}</Typography>
        </View>
        <View
          className="flex-row items-center gap-1"
          accessibilityLabel={`${card.social.comments} comments`}
        >
          <MessageCircle size={14} color={colors.fg["45"]} />
          <Typography variant="micro">{card.social.comments}</Typography>
        </View>
        <Typography variant="micro" className="ml-auto">
          {seatsLeft > 0 ? `${seatsLeft} of ${card.seats} seats open` : "All seats taken"}
        </Typography>
      </View>
    </PressableScale>
  );
}
