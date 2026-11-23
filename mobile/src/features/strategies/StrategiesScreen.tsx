import { useEffect, useRef } from "react";
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import { formatEmbargo, formatPrice, strategyReturnText } from "@/domain/strategies";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useStrategyOwner } from "./useStrategyOwner";

type Props = NativeStackScreenProps<RootStackParamList, "Strategies">;

/** The strategies this wallet sells, found from its own strategy keys. */
export function StrategiesScreen({ navigation }: Props) {
  const owner = useStrategyOwner();
  const { reload } = owner;
  // Coming back from publishing or an update shows the new state. The first focus is the
  // screen opening, which the hook already reads for.
  const seen = useRef(false);
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (seen.current) reload();
        seen.current = true;
      }),
    [navigation, reload],
  );
  return (
    <Screen refreshing={owner.loading} onRefresh={() => void reload()}>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">Your strategies</Typography>
        <Typography variant="body">
          Sell your basket&apos;s weights. Your wallets, amounts and identity stay private.
        </Typography>
      </View>
      {owner.error && <Notice error message={owner.error} />}
      {owner.loading && owner.owned.length === 0 && (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Loading your strategies…
        </Typography>
      )}
      {!owner.loading && !owner.error && owner.owned.length === 0 && (
        <Typography variant="rowValue" className="!text-fg-45">
          You haven&apos;t published a strategy yet.
        </Typography>
      )}
      <View className="gap-3">
        {owner.owned.map(({ card }) => (
          <View
            key={card.id}
            accessibilityLabel={`Strategy ${card.name}`}
            className="gap-2 rounded-2xl border border-glassBorder bg-glass px-4 py-4"
          >
            <Typography variant="cardTitle">{card.name}</Typography>
            <Typography variant="rowValue">{strategyReturnText(card)}</Typography>
            <Typography variant="micro">
              {card.seatsTaken}/{card.seats} seats · {card.commits} updates sealed · {card.revealed}{" "}
              revealed · {formatEmbargo(card.embargoSeconds)} embargo
            </Typography>
            <Typography variant="micro">Earned {formatPrice(card.earnedAtoms)}</Typography>
            {card.broken && (
              <Notice
                error
                message="An update is past its reveal time. Gizu retries the reveal automatically."
              />
            )}
            <Button
              label="Send update"
              accessibilityLabel={`Send update for ${card.name}`}
              variant="secondary"
              disabled={owner.busy}
              onPress={() => navigation.navigate("StrategyPublish", { strategyId: card.id })}
            />
          </View>
        ))}
      </View>
      {!owner.loading && owner.nextIndex !== null && (
        <Button
          label="Publish a strategy"
          disabled={owner.busy}
          onPress={() => navigation.navigate("StrategyPublish")}
        />
      )}
    </Screen>
  );
}
