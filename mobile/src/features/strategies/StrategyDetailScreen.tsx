import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import {
  drawdownText,
  formatEmbargo,
  formatPrice,
  formatWeight,
  strategyReturnText,
  vaultChanges,
} from "@/domain/strategies";
import { behindText, signalAssetInfo } from "@/domain/strategyCopy";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { CopyBasketPanel } from "./components/CopyBasketPanel";
import { useStrategyFollower } from "./useStrategyFollower";

type Props = NativeStackScreenProps<RootStackParamList, "StrategyDetail">;

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const percent = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

export function StrategyDetailScreen({ route }: Props) {
  // Deep links reach here with any text; only a positive integer names a strategy.
  const id = Number(route.params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return (
      <Screen>
        <BackAction fallback="Home" />
        <Notice error message="This strategy link isn't valid." />
      </Screen>
    );
  return <StrategyDetail id={id} />;
}

function StrategyDetail({ id }: { id: number }) {
  const s = useStrategyFollower(id);
  const { detail, follow, signal } = s;
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

  const revealed = detail.history
    .filter((entry) => entry.revealedAt !== null)
    .sort((a, b) => b.seq - a.seq);
  const seatsLeft = detail.seats - detail.seatsTaken;
  const drawdown = drawdownText(detail);
  const changes = vaultChanges(detail.history);
  const behind =
    signal &&
    follow &&
    follow.copiedSeq !== null &&
    follow.copiedSeq < signal.seq &&
    signal.committedAt
      ? behindText(signal.committedAt, s.now())
      : null;

  return (
    <Screen refreshing={s.loading} onRefresh={s.reload}>
      <BackAction fallback="Home" />
      <View className="gap-1">
        <Typography variant="pageTitle">{detail.name}</Typography>
        <Typography variant="rowValue">{strategyReturnText(detail)}</Typography>
        <Typography variant="micro">
          {[
            drawdown,
            `${detail.revealed}/${detail.commits} updates revealed`,
            `weights revealed after ${formatEmbargo(detail.embargoSeconds)}`,
            changes > 0 ? `vault share changed ${changes} time${changes === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Typography>
      </View>
      {detail.broken && (
        <Notice
          error
          message="An update is past its reveal time. Its record can't be checked until it is revealed."
        />
      )}
      {s.loadError && <Notice error message={s.loadError} />}
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

      {revealed.length > 0 && (
        <View className="gap-2">
          <Typography variant="section">Revealed record</Typography>
          {revealed.map((entry) => (
            <View key={entry.seq} className="gap-1">
              <Typography variant="rowValue">
                Update {entry.seq}
                {entry.committedAt ? ` · sealed ${day(entry.committedAt)}` : ""}
                {entry.periodReturnBps !== null ? ` · ${percent(entry.periodReturnBps)}` : ""}
              </Typography>
              <Typography variant="micro">
                {entry.assets
                  .map(
                    (asset) => `${signalAssetInfo(asset).label} ${formatWeight(asset.weightBps)}`,
                  )
                  .join(" · ")}
              </Typography>
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}
