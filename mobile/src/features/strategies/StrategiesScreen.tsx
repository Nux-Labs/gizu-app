import { useEffect, useRef } from "react";
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useStrategyOwner } from "./useStrategyOwner";

type Props = NativeStackScreenProps<RootStackParamList, "Strategies">;

/**
 * This wallet's strategy. A wallet sells one strategy, its own portfolio, so once published this
 * opens its profile; before that it explains what publishing shares.
 */
export function StrategiesScreen({ navigation }: Props) {
  const owner = useStrategyOwner();
  const { reload, strategy } = owner;
  // Coming back from publishing shows the new strategy. The first focus is the screen opening,
  // which the hook already reads for.
  const seen = useRef(false);
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (seen.current) reload();
        seen.current = true;
      }),
    [navigation, reload],
  );
  useEffect(() => {
    if (strategy) navigation.replace("StrategyDetail", { id: strategy.card.id });
  }, [navigation, strategy]);

  return (
    <Screen refreshing={owner.loading} onRefresh={() => void reload()}>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">Your strategy</Typography>
        <Typography variant="body">
          Sell the weights of the portfolio you hold. Every update is sealed on Base, revealed after
          your embargo and stays on your public record for good. Your wallets, amounts and identity
          stay private.
        </Typography>
      </View>
      {owner.error && <Notice error message={owner.error} />}
      {owner.loading && (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Loading your strategy…
        </Typography>
      )}
      {!owner.loading && !owner.error && !strategy && (
        <>
          <Typography variant="rowValue" className="!text-fg-45">
            You haven&apos;t published your strategy yet. Each wallet publishes one.
          </Typography>
          {owner.nextIndex !== null && (
            <Button
              label="Publish your strategy"
              disabled={owner.busy}
              onPress={() => navigation.navigate("StrategyPublish")}
            />
          )}
        </>
      )}
    </Screen>
  );
}
