import { useEffect, useRef } from "react";
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Typography } from "@/components/atoms/Typography";
import { PressableScale } from "@/components/atoms/PressableScale";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import {
  drawdownText,
  formatEmbargo,
  strategyReturnText,
  type StrategyCard,
} from "@/domain/strategies";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useStrategyList } from "./useStrategyFollower";

type Props = NativeStackScreenProps<RootStackParamList, "StrategyExplore">;

/** Verified records first, then the most active; broken strategies last. */
function rank(a: StrategyCard, b: StrategyCard): number {
  if (a.broken !== b.broken) return a.broken ? 1 : -1;
  const ra = a.performance.cumulativeReturnBps;
  const rb = b.performance.cumulativeReturnBps;
  if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
  if (ra !== null && rb !== null && ra !== rb) return rb - ra;
  return b.commits - a.commits;
}

export function StrategyExploreScreen({ navigation }: Props) {
  const list = useStrategyList();
  const { reload } = list;
  // Coming back from a strategy shows whether it is now followed.
  const seen = useRef(false);
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (seen.current) reload();
        seen.current = true;
      }),
    [navigation, reload],
  );
  const cards = [...list.cards].filter((card) => card.commits > 0).sort(rank);
  return (
    <Screen refreshing={list.loading} onRefresh={reload}>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">Follow a strategy</Typography>
        <Typography variant="body">
          Copy a basket from another Gizu user. Every update is sealed on Base before you see it,
          and its weights are revealed later, so its record can&apos;t be rewritten.
        </Typography>
      </View>
      {list.error && <Notice error message={list.error} />}
      {list.loading && list.cards.length === 0 && (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Loading strategies…
        </Typography>
      )}
      {!list.loading && !list.error && cards.length === 0 && (
        <Typography variant="rowValue" className="!text-fg-45">
          No strategy has sealed a basket yet.
        </Typography>
      )}
      <View className="gap-3">
        {cards.map((card) => {
          const seatsLeft = card.seats - card.seatsTaken;
          const following = list.followed.has(card.id);
          const drawdown = drawdownText(card);
          return (
            <PressableScale
              key={card.id}
              accessibilityRole="button"
              accessibilityLabel={`Open strategy ${card.name}`}
              onPress={() => navigation.navigate("StrategyDetail", { id: card.id })}
              className="gap-2 rounded-2xl border border-glassBorder bg-glass px-4 py-4"
            >
              <View className="flex-row items-center justify-between gap-2">
                <Typography variant="cardTitle">{card.name}</Typography>
                {following ? (
                  <Typography variant="micro">Following</Typography>
                ) : card.broken ? (
                  <Typography variant="micro" className="!text-danger">
                    Late reveal
                  </Typography>
                ) : null}
              </View>
              <Typography variant="rowValue">{strategyReturnText(card)}</Typography>
              <Typography variant="micro">
                {[
                  drawdown,
                  `${card.revealed}/${card.commits} updates revealed`,
                  `${formatEmbargo(card.embargoSeconds)} delay`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Typography>
              <Typography variant="micro">
                {seatsLeft > 0 ? `${seatsLeft} of ${card.seats} seats open` : "All seats taken"}
              </Typography>
            </PressableScale>
          );
        })}
      </View>
    </Screen>
  );
}
