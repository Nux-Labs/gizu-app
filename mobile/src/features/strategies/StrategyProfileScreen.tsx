import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { UnderlineTabs } from "@/components/molecules/UnderlineTabs";
import { Notice } from "@/components/molecules/Notice";
import { StatGrid } from "@/components/molecules/StatGrid";
import { LineChart } from "@/components/molecules/chart/LineChart";
import { Screen } from "@/components/templates/Screen";
import {
  drawdownText,
  formatEmbargo,
  formatPrice,
  formatWeight,
  holdingAmounts,
  holdingsChanged,
  type StrategyDetail,
} from "@/domain/strategies";
import { behindText, signalAssetInfo } from "@/domain/strategyCopy";
import {
  cadenceText,
  durationText,
  isNewStrategy,
  pendingReveal,
  percentText,
  returnSeries,
  revealedUpdates,
  updateCadenceDays,
} from "@/domain/strategyProfile";
import { usePricedPortfolio } from "@/features/wallet/usePricedPortfolio";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { AllocationHistory } from "./components/AllocationHistory";
import { CommentsSection } from "./components/CommentsSection";
import { CopyBasketPanel } from "./components/CopyBasketPanel";
import { CommentCount, LikeButton } from "./components/LikeButton";
import { StrategyAvatar } from "./components/StrategyAvatar";
import { UpdateCard } from "./components/UpdateCard";
import { useStrategyFollower } from "./useStrategyFollower";
import { useOwnStrategySigners, useSealRecords } from "./useStrategyOwner";
import { useSocialSession, useStrategySocialDeps } from "./useStrategySocial";

type Props = NativeStackScreenProps<RootStackParamList, "StrategyDetail">;
type Tab = "history" | "performance" | "allocation" | "comments";
type Follower = ReturnType<typeof useStrategyFollower>;

const profileTabs = [
  { key: "history", label: "History" },
  { key: "performance", label: "Returns" },
  { key: "allocation", label: "Allocation" },
  { key: "comments", label: "Comments" },
] as const satisfies readonly { key: Tab; label: string }[];

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function StrategyProfileScreen({ route }: Props) {
  // Deep links reach here with any text; only a positive integer names a strategy.
  const id = Number(route.params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return (
      <Screen>
        <BackAction fallback="Home" />
        <Notice error message="This strategy link isn't valid." />
      </Screen>
    );
  return <StrategyProfile id={id} />;
}

function StrategyProfile({ id }: { id: number }) {
  const { session } = useSocialSession();
  const s = useStrategyFollower(id, session?.token ?? null);
  const own = useOwnStrategySigners();
  const { now } = useStrategySocialDeps();
  const [tab, setTab] = useState<Tab>("history");
  const { detail, reload } = s;
  const navigation = useNavigation();
  // Coming back from an update, a price change or a copy shows the new state. The first focus is
  // the screen opening, which the hook already reads for.
  const seen = useRef(false);
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (seen.current) reload();
        seen.current = true;
      }),
    [navigation, reload],
  );
  if (!detail)
    return (
      <Screen refreshing={s.loading} onRefresh={s.reload}>
        <BackAction fallback="Home" />
        {s.loadError ? (
          <>
            <Notice error message={s.loadError} />
            <Button label="Try again" onPress={s.reload} />
          </>
        ) : (
          <Typography accessibilityLiveRegion="polite">Loading strategy…</Typography>
        )}
      </Screen>
    );

  const nowMs = now();
  const mine = own.has(detail.signer.toLowerCase());
  const drawdown = drawdownText(detail);
  const ret = detail.performance.cumulativeReturnBps;
  const pending = pendingReveal(detail, nowMs);

  return (
    <Screen refreshing={s.loading} onRefresh={s.reload}>
      <BackAction fallback="Home" />
      <View className="flex-row items-center gap-4">
        <StrategyAvatar signer={detail.signer} name={detail.name} size={64} />
        <View className="min-w-0 flex-1 gap-1">
          <Typography variant="pageTitle" numberOfLines={2}>
            {detail.name}
          </Typography>
          <Typography variant="micro">
            {[
              mine ? "Yours" : null,
              isNewStrategy(detail, nowMs) ? "New" : null,
              `since ${day(detail.createdAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Typography>
        </View>
      </View>
      <Typography variant="rowValue">
        {formatPrice(detail.monthlyPriceAtoms)} a month · {formatPrice(detail.signalPriceAtoms)} per
        agent signal · weights revealed {formatEmbargo(detail.embargoSeconds)} after each update
      </Typography>
      <StatGrid
        stats={[
          {
            label: "Verified return",
            value: ret === null ? "After 1st reveal" : percentText(ret),
            accent: ret !== null && ret > 0,
          },
          { label: "Worst drop", value: drawdown ? drawdown.replace("Worst drop ", "") : "—" },
          { label: "Reveals", value: `${detail.revealed}/${detail.commits}` },
          { label: "Followers", value: `${detail.seatsTaken}/${detail.seats}` },
          { label: "Updates", value: cadenceText(updateCadenceDays(detail.history)) },
        ]}
      />
      <View className="flex-row items-center gap-4">
        <LikeButton
          strategyId={detail.id}
          seq={null}
          liked={detail.liked}
          count={detail.social.likes}
          subject={detail.name}
        />
        <CommentCount
          count={detail.social.comments}
          subject={detail.name}
          onPress={() => setTab("comments")}
        />
      </View>
      {detail.broken && (
        <Notice
          error
          message="An update is past its reveal time. Its record can't be checked until it is revealed."
        />
      )}
      {pending && (
        <Notice
          message={
            pending.inMs !== null
              ? `1 sealed update. Its weights are revealed in ${durationText(pending.inMs)}.`
              : `${pending.waiting} sealed updates waiting for their reveal.`
          }
        />
      )}
      {s.loadError && <Notice error message={s.loadError} />}

      {mine ? <OwnerPanel detail={detail} /> : <FollowPanel s={s} detail={detail} />}

      <UnderlineTabs tabs={profileTabs} selected={tab} onSelect={setTab} />
      {tab === "history" && <History detail={detail} nowMs={nowMs} />}
      {tab === "performance" && <Performance detail={detail} />}
      {tab === "allocation" && <AllocationHistory history={detail.history} />}
      {tab === "comments" && <CommentsSection strategyId={detail.id} seq={null} />}
    </Screen>
  );
}

function History({ detail, nowMs }: { detail: StrategyDetail; nowMs: number }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const updates = revealedUpdates(detail.history).reverse();
  const prices = [...detail.priceHistory].sort((a, b) => b.version - a.version);
  return (
    <View className="gap-3">
      {updates.length === 0 && (
        <Typography variant="rowValue" className="!text-fg-45">
          No revealed update yet. Sealed updates appear here once their embargo ends.
        </Typography>
      )}
      {updates.map(({ entry, previous }) => (
        <UpdateCard
          key={entry.seq}
          strategyId={detail.id}
          strategyName={detail.name}
          seq={entry.seq}
          at={entry.revealedAt}
          assets={entry.assets}
          previous={previous}
          periodReturnBps={entry.periodReturnBps}
          likes={entry.likes}
          comments={entry.comments}
          liked={entry.liked}
          commitTx={entry.commitTx}
          revealTx={entry.revealTx}
          nowMs={nowMs}
          onOpenComments={() =>
            navigation.navigate("StrategyUpdate", { id: detail.id, seq: entry.seq })
          }
        />
      ))}
      {prices.length > 1 && (
        <View className="gap-1" accessibilityLabel="Price history">
          <Typography variant="rowTitle">Price history</Typography>
          {prices.map((price) => (
            <Typography key={price.version} variant="micro">
              {day(price.at)} · {formatPrice(price.monthlyPriceAtoms)} a month ·{" "}
              {formatPrice(price.signalPriceAtoms)} per signal
              {price.version === 0 ? " (at launch)" : ""}
            </Typography>
          ))}
        </View>
      )}
    </View>
  );
}

function Performance({ detail }: { detail: StrategyDetail }) {
  const series = returnSeries(detail.history);
  if (series.length < 2)
    return (
      <Typography variant="rowValue" className="!text-fg-45">
        The return chart starts after the first closed period.
      </Typography>
    );
  const last = series[series.length - 1]!;
  return (
    <View className="gap-2">
      <Typography variant="micro">
        Growth of 100 through each revealed period, priced when it opened and closed.
      </Typography>
      <LineChart series={series} height={160} up={last >= 100} format={(v) => v.toFixed(1)} />
      <Typography variant="micro">
        {detail.performance.closedPeriods} closed periods ·{" "}
        {percentText(Math.round((last - 100) * 100))} in total
      </Typography>
    </View>
  );
}

/** The owner's view: send an update, change the price, and see when the portfolio moved on. */
function OwnerPanel({ detail }: { detail: StrategyDetail }) {
  const nowMs = useStrategySocialDeps().now();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const records = useSealRecords();
  const { snapshot } = usePricedPortfolio();
  const [sealed, setSealed] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let active = true;
    void records.load(detail.id).then((record) => {
      if (active) setSealed(record?.amounts ?? null);
    });
    return () => {
      active = false;
    };
  }, [detail.id, detail.commits, records]);
  const changed =
    sealed !== null && snapshot !== null && holdingsChanged(sealed, holdingAmounts(snapshot));
  const nextPrice = detail.priceChangeAllowedAt;
  return (
    <View className="gap-3 rounded-2xl border border-glassBorder bg-glass px-4 py-4">
      <Typography variant="cardTitle">Your strategy</Typography>
      <Typography variant="micro">
        Earned {formatPrice(detail.earnedAtoms)} · {detail.seatsTaken} of {detail.seats} seats taken
      </Typography>
      {changed && (
        <Notice message="Your portfolio changed since your last update. Send an update so subscribers get the weights you hold now." />
      )}
      <Button
        label="Send update"
        variant={changed ? "primary" : "secondary"}
        onPress={() => navigation.navigate("StrategyPublish", { strategyId: detail.id })}
      />
      <Button
        label="Change price"
        variant="secondary"
        disabled={nextPrice !== null && Date.parse(nextPrice) > nowMs}
        onPress={() => navigation.navigate("StrategyPrice", { strategyId: detail.id })}
      />
      {nextPrice !== null && Date.parse(nextPrice) > nowMs && (
        <Typography variant="micro">The price can change again on {day(nextPrice)}.</Typography>
      )}
    </View>
  );
}

/** A follower's view: start a trial, see the current basket and copy it. */
function FollowPanel({ s, detail }: { s: Follower; detail: StrategyDetail }) {
  const { follow, signal } = s;
  const seatsLeft = detail.seats - detail.seatsTaken;
  const behind =
    signal &&
    follow &&
    follow.copiedSeq !== null &&
    follow.copiedSeq < signal.seq &&
    signal.committedAt
      ? behindText(signal.committedAt, s.now())
      : null;
  return (
    <View className="gap-3">
      {s.operationError && <Notice error message={s.operationError} />}
      {s.pushNotice && <Notice message={s.pushNotice} />}
      {!follow && (
        <View className="gap-2">
          <Typography variant="body">
            Follow to see the current basket the moment it&apos;s sealed. 30-day free trial, then{" "}
            {formatPrice(detail.monthlyPriceAtoms)} a month. Nothing is charged in this version.
          </Typography>
          <Typography variant="micro">
            {seatsLeft > 0 ? `${seatsLeft} of ${detail.seats} seats open` : "All seats are taken."}
          </Typography>
          <Button
            label="Start free trial"
            disabled={s.busy || seatsLeft <= 0}
            onPress={() => void s.subscribe()}
          />
        </View>
      )}
      {follow && s.expired && (
        <View className="gap-2">
          <Notice message="Your trial for this strategy has ended." />
          <Button
            label="Stop following"
            variant="secondary"
            disabled={s.busy}
            onPress={() => void s.unfollow()}
          />
        </View>
      )}
      {follow && !s.expired && !signal && (
        <Typography variant="body">This strategy hasn&apos;t sealed a basket yet.</Typography>
      )}
      {follow && !s.expired && signal && (
        <View className="gap-3">
          <Typography variant="section">Current basket</Typography>
          <Typography variant="micro">
            Update {signal.seq}
            {signal.committedAt ? `, sealed on Base ${day(signal.committedAt)}` : ""}
          </Typography>
          {signal.assets.map((asset) => {
            const label = signalAssetInfo(asset).label;
            return (
              <View
                key={asset.assetId}
                accessibilityLabel={`${label} ${formatWeight(asset.weightBps)}`}
                className="flex-row justify-between"
              >
                <Typography variant="rowValue">{label}</Typography>
                <Typography variant="rowValue">{formatWeight(asset.weightBps)}</Typography>
              </View>
            );
          })}
          {behind && <Notice message={`Your copy is ${behind} behind this basket.`} />}
          {follow.copiedSeq === signal.seq && <Notice message="Your copy matches this basket." />}
          <CopyBasketPanel
            signal={signal}
            copiedSeq={follow.copiedSeq}
            onCopied={(seq) => void s.markCopied(seq)}
          />
          {!s.pushOn && (
            <Button
              label="Notify me about updates"
              variant="secondary"
              disabled={s.busy}
              onPress={() => void s.enableNotifications()}
            />
          )}
        </View>
      )}
    </View>
  );
}
