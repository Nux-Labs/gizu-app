import { useEffect, useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Choice } from "@/components/molecules/Choice";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import {
  basketAssets,
  basketFromPortfolio,
  basketProblem,
  demoEmbargo,
  embargoOptions,
  formatEmbargo,
  formatPrice,
  metadataProblem,
  suggestedWeights,
  unsupportedHoldings,
  usdcAtoms,
  type BasketLine,
} from "@/domain/strategies";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { useMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import colors from "@/theme/colors.json";
import { BasketEditor } from "./components/BasketEditor";
import { useStrategyOwner, type StrategyStage } from "./useStrategyOwner";

const inputClass = "min-h-12 rounded-xl bg-well px-4 py-3 text-text";
const embargoes = __DEV__ ? [demoEmbargo, ...embargoOptions] : embargoOptions;
const stageText: Record<StrategyStage, string | null> = {
  idle: null,
  approving: "Review and approve with your passkey…",
  publishing: "Publishing your strategy…",
  sealing: "Sealing the basket…",
};

type Props = NativeStackScreenProps<RootStackParamList, "StrategyPublish">;

/** Publishes a strategy from the portfolio, or seals a new basket for an existing one. */
export function StrategyPublishScreen({ navigation, route }: Props) {
  const strategyId = route.params?.strategyId;
  const owner = useStrategyOwner();
  const { snapshot } = useMainnetWallet();
  const existing = owner.owned.find((strategy) => strategy.card.id === strategyId) ?? null;
  const updating = strategyId !== undefined;
  // Leaving mid-operation would let another screen start a second one on the same key.
  usePreventRemove(owner.busy, () => {});

  // Lines come from the first portfolio read; later refreshes keep the weights already edited.
  const [lines, setLines] = useState<BasketLine[] | null>(null);
  const [weights, setWeights] = useState<number[]>([]);
  if (lines === null && snapshot) {
    const found = basketFromPortfolio(snapshot);
    setLines(found);
    setWeights(suggestedWeights(found));
  }

  const [name, setName] = useState("");
  const [monthly, setMonthly] = useState("10");
  const [perSignal, setPerSignal] = useState("0.5");
  const [seats, setSeats] = useState("20");
  const [embargo, setEmbargo] = useState<number>(embargoOptions[1].seconds);

  const metadata = useMemo(
    () => ({
      name,
      monthlyPriceAtoms: usdcAtoms(monthly) ?? "",
      signalPriceAtoms: usdcAtoms(perSignal) ?? "",
      seats: /^\d{1,3}$/.test(seats) ? Number(seats) : 0,
    }),
    [monthly, name, perSignal, seats],
  );
  const problem = basketProblem(weights) ?? (updating ? null : metadataProblem(metadata));
  const ready =
    !owner.loading &&
    !owner.busy &&
    problem === null &&
    (updating ? existing !== null : owner.nextIndex !== null);

  // Leave only once the finished operation has re-rendered as idle; until then the screen is
  // still guarded against removal.
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (finished && !owner.busy) navigation.goBack();
  }, [finished, navigation, owner.busy]);

  const submit = async () => {
    const assets = basketAssets(lines ?? [], weights);
    if (updating) {
      if (existing !== null && (await owner.sendUpdate(existing, assets))) setFinished(true);
      return;
    }
    const result = await owner.publish(metadata, embargo, assets);
    if (result.ok) setFinished(true);
    // Published but not sealed: finish this strategy instead of offering to publish another.
    else if (result.strategyId !== null) navigation.setParams({ strategyId: result.strategyId });
  };
  const refill = () => {
    if (!snapshot) return;
    const found = basketFromPortfolio(snapshot);
    setLines(found);
    setWeights(suggestedWeights(found));
  };
  const leftOut = snapshot ? unsupportedHoldings(snapshot) : [];

  const status = stageText[owner.stage];
  return (
    <Screen>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">
          {updating ? `Update ${existing?.card.name ?? "strategy"}` : "Sell your strategy"}
        </Typography>
        <Typography variant="body">
          {updating
            ? "Seal your new weights on chain and send them to your subscribers."
            : "Subscribers and agents buy your basket's weights. Your wallets, amounts and identity stay private."}
        </Typography>
      </View>

      <Typography variant="section">Basket</Typography>
      {!lines || lines.length === 0 ? (
        <Typography variant="rowValue" className="!text-fg-45">
          {snapshot
            ? "Your portfolio has no stocks, vaults or USDC to build a basket from yet."
            : "Reading your portfolio…"}
        </Typography>
      ) : (
        <BasketEditor lines={lines} weights={weights} onChange={setWeights} disabled={owner.busy} />
      )}
      {leftOut.length > 0 && (
        <Notice
          message={`Not included because strategies don't support them yet: ${leftOut.join(", ")}.`}
        />
      )}
      {snapshot && (
        <View className="self-start">
          <Button
            label="Refill from my portfolio"
            variant="quiet"
            disabled={owner.busy}
            onPress={refill}
          />
        </View>
      )}

      {!updating && (
        <>
          <Typography variant="section">Terms</Typography>
          <View className="gap-3">
            <TextInput
              accessibilityLabel="Strategy name"
              placeholder="Strategy name"
              placeholderTextColor={colors.fg["35"]}
              value={name}
              onChangeText={setName}
              maxLength={48}
              editable={!owner.busy}
              className={inputClass}
            />
            <View className="flex-row gap-3">
              <View className="flex-1 gap-1">
                <Typography variant="micro">Monthly price (USDC)</Typography>
                <TextInput
                  accessibilityLabel="Monthly price in USDC"
                  keyboardType="decimal-pad"
                  value={monthly}
                  onChangeText={setMonthly}
                  editable={!owner.busy}
                  className={inputClass}
                />
              </View>
              <View className="flex-1 gap-1">
                <Typography variant="micro">Per signal for agents (USDC)</Typography>
                <TextInput
                  accessibilityLabel="Price per signal in USDC"
                  keyboardType="decimal-pad"
                  value={perSignal}
                  onChangeText={setPerSignal}
                  editable={!owner.busy}
                  className={inputClass}
                />
              </View>
            </View>
            <View className="gap-1">
              <Typography variant="micro">Seats</Typography>
              <TextInput
                accessibilityLabel="Subscriber seats"
                keyboardType="number-pad"
                value={seats}
                onChangeText={setSeats}
                editable={!owner.busy}
                className={inputClass}
              />
            </View>
            <View className="gap-2">
              <Typography variant="micro">
                Weights become public after the embargo. It cannot be changed later.
              </Typography>
              <View className="flex-row flex-wrap gap-2">
                {embargoes.map((option) => (
                  <Choice
                    key={option.seconds}
                    label={option.label}
                    selected={embargo === option.seconds}
                    disabled={owner.busy}
                    onPress={() => setEmbargo(option.seconds)}
                  />
                ))}
              </View>
            </View>
          </View>

          <Typography variant="section">What others will see</Typography>
          <View
            accessibilityLabel="Strategy preview"
            className="gap-2 rounded-2xl border border-glassBorder bg-glass px-4 py-4"
          >
            <Typography variant="cardTitle">{name || "Your strategy"}</Typography>
            <Typography variant="rowValue">
              {metadata.monthlyPriceAtoms && metadata.signalPriceAtoms
                ? `${formatPrice(metadata.monthlyPriceAtoms)} a month · ${formatPrice(metadata.signalPriceAtoms)} per agent signal`
                : "Set your prices"}
            </Typography>
            <Typography variant="micro">
              {metadata.seats || "?"} seats · weights revealed {formatEmbargo(embargo)} after each
              update
            </Typography>
            <Typography variant="micro">Return: verified after the first reveal</Typography>
          </View>
          <Notice message="Never shared: your wallets, balances, amounts or identity. A separate strategy key signs on Base and holds no funds." />
        </>
      )}

      {owner.error && <Notice error message={owner.error} />}
      {status && (
        <Typography variant="rowTitle" accessibilityLiveRegion="polite">
          {status}
        </Typography>
      )}
      {!updating && owner.keysExhausted && (
        <Notice message="This wallet has used all of its strategy keys." />
      )}
      {updating && !owner.loading && !owner.error && existing === null && (
        <Notice error message="This strategy isn't one of this wallet's strategies." />
      )}
      <Button
        label={updating ? "Seal and send update" : "Publish strategy"}
        disabled={!ready}
        loading={owner.busy}
        onPress={() => void submit()}
      />
      <Typography variant="micro">
        {updating
          ? "One passkey approval seals the basket. No funds move."
          : "Two passkey approvals: one publishes the strategy, one seals its first basket. No funds move."}
      </Typography>
    </Screen>
  );
}
