import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import { formatPrice, usdcAtoms } from "@/domain/strategies";
import { formatUsdc } from "@/domain/wallet/amounts";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useStrategyOwner } from "./useStrategyOwner";
import { useStrategySocialDeps } from "./useStrategySocial";

type Props = NativeStackScreenProps<RootStackParamList, "StrategyPrice">;

const inputClass = "min-h-12 rounded-xl bg-well px-4 py-3 text-text";
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/**
 * The owner sets a new price. It applies to new subscriptions and agent signals; current seats run
 * to their end at the price they started with. The embargo never changes.
 */
export function StrategyPriceScreen({ route, navigation }: Props) {
  const owner = useStrategyOwner();
  const nowMs = useStrategySocialDeps().now();
  const strategy = owner.owned.find((item) => item.card.id === route.params.strategyId) ?? null;
  const card = strategy?.card ?? null;
  const [monthly, setMonthly] = useState<string | null>(null);
  const [perSignal, setPerSignal] = useState<string | null>(null);
  usePreventRemove(owner.busy, () => {});

  // Start from the current price once the strategy has loaded.
  if (card && monthly === null) {
    setMonthly(formatUsdc(card.monthlyPriceAtoms));
    setPerSignal(formatUsdc(card.signalPriceAtoms));
  }

  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (finished && !owner.busy) navigation.goBack();
  }, [finished, navigation, owner.busy]);

  const monthlyAtoms = usdcAtoms(monthly ?? "");
  const signalAtoms = usdcAtoms(perSignal ?? "");
  const waitUntil =
    card?.priceChangeAllowedAt && Date.parse(card.priceChangeAllowedAt) > nowMs
      ? card.priceChangeAllowedAt
      : null;
  const unchanged =
    !!card && monthlyAtoms === card.monthlyPriceAtoms && signalAtoms === card.signalPriceAtoms;
  const problem = !card
    ? null
    : monthlyAtoms === null || signalAtoms === null
      ? "Enter both prices in USDC."
      : unchanged
        ? "Change at least one price."
        : null;
  const ready = !!strategy && !owner.busy && !waitUntil && problem === null;

  return (
    <Screen>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">Change price</Typography>
        <Typography variant="body">
          New subscribers and agents pay the new price. Current seats run to their end at the price
          they started with. Weights are still revealed after the same embargo; that never changes.
        </Typography>
      </View>
      {owner.loading && !card && (
        <Typography accessibilityLiveRegion="polite">Loading your strategy…</Typography>
      )}
      {!owner.loading && !card && !owner.error && (
        <Notice error message="This strategy isn't one of this wallet's strategies." />
      )}
      {card && (
        <>
          <Typography variant="micro">
            Now {formatPrice(card.monthlyPriceAtoms)} a month and{" "}
            {formatPrice(card.signalPriceAtoms)} per agent signal.
          </Typography>
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1">
              <Typography variant="micro">Monthly price (USDC)</Typography>
              <TextInput
                accessibilityLabel="New monthly price in USDC"
                keyboardType="decimal-pad"
                value={monthly ?? ""}
                onChangeText={setMonthly}
                editable={!owner.busy}
                className={inputClass}
              />
            </View>
            <View className="flex-1 gap-1">
              <Typography variant="micro">Per signal for agents (USDC)</Typography>
              <TextInput
                accessibilityLabel="New price per signal in USDC"
                keyboardType="decimal-pad"
                value={perSignal ?? ""}
                onChangeText={setPerSignal}
                editable={!owner.busy}
                className={inputClass}
              />
            </View>
          </View>
          {problem && <Typography variant="micro">{problem}</Typography>}
          {waitUntil && (
            <Notice
              message={`The price can change once every 7 days. Next change: ${day(waitUntil)}.`}
            />
          )}
        </>
      )}
      {owner.error && <Notice error message={owner.error} />}
      {owner.stage === "approving" && (
        <Typography variant="rowTitle" accessibilityLiveRegion="polite">
          Review and approve with your passkey…
        </Typography>
      )}
      <Button
        label="Save new price"
        disabled={!ready}
        loading={owner.busy}
        onPress={async () => {
          if (!strategy || monthlyAtoms === null || signalAtoms === null) return;
          if (await owner.changePrice(strategy, monthlyAtoms, signalAtoms)) setFinished(true);
        }}
      />
      <Typography variant="micro">
        One passkey approval signs the new price with your strategy key. No funds move. Followers
        are notified.
      </Typography>
    </Screen>
  );
}
