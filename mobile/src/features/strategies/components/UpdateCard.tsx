import { Linking, Pressable, View } from "react-native";
import { Typography } from "@/components/atoms/Typography";
import { formatWeight, type SealedAssetView } from "@/domain/strategies";
import { signalAssetInfo } from "@/domain/strategyCopy";
import { agoText, basketChanges, changeText, percentText } from "@/domain/strategyProfile";
import { CommentCount, LikeButton } from "./LikeButton";

const BASESCAN = "https://sepolia.basescan.org/tx/";

/** A revealed update: what changed, its period's verified return, and its likes and comments. */
export function UpdateCard({
  strategyId,
  strategyName,
  seq,
  at,
  assets,
  previous,
  periodReturnBps,
  likes,
  comments,
  liked,
  commitTx,
  revealTx,
  nowMs,
  showStrategy = false,
  onOpenStrategy,
  onOpenComments,
}: {
  strategyId: number;
  strategyName: string;
  seq: number;
  at: string | null;
  assets: readonly SealedAssetView[];
  previous: readonly SealedAssetView[] | null;
  periodReturnBps: number | null;
  likes: number;
  comments: number;
  liked: boolean;
  commitTx?: string | null;
  revealTx?: string | null;
  nowMs: number;
  showStrategy?: boolean;
  onOpenStrategy?: () => void;
  onOpenComments: () => void;
}) {
  const changes = basketChanges(previous, assets);
  const subject = `${strategyName} update ${seq}`;
  return (
    <View
      accessibilityLabel={`${strategyName} update ${seq}`}
      className="gap-3 rounded-2xl border border-glassBorder bg-glass px-4 py-4"
    >
      <View className="flex-row items-center justify-between gap-2">
        {showStrategy && onOpenStrategy ? (
          <Pressable accessibilityRole="link" onPress={onOpenStrategy} className="min-w-0 flex-1">
            <Typography variant="rowTitle" numberOfLines={1}>
              {strategyName} · revealed update {seq}
            </Typography>
          </Pressable>
        ) : (
          <Typography variant="rowTitle" className="flex-1">
            Update {seq}
          </Typography>
        )}
        {at && <Typography variant="micro">{agoText(at, nowMs)}</Typography>}
      </View>
      {changes.length > 0 && previous !== null && (
        <View className="flex-row flex-wrap gap-1.5" accessibilityLabel="Changes">
          {changes.map((change) => (
            <View
              key={`${change.kind}:${change.label}`}
              className="rounded-full border border-glassBorder px-2 py-0.5"
            >
              <Typography
                variant="micro"
                className={
                  change.kind === "added"
                    ? "!text-accent"
                    : change.kind === "removed"
                      ? "!text-danger"
                      : ""
                }
              >
                {changeText(change)}
              </Typography>
            </View>
          ))}
        </View>
      )}
      <Typography variant="rowValue">
        {[...assets]
          .sort((a, b) => b.weightBps - a.weightBps)
          .map((asset) => `${signalAssetInfo(asset).label} ${formatWeight(asset.weightBps)}`)
          .join(" · ")}
      </Typography>
      <Typography variant="micro">
        {periodReturnBps === null
          ? "Period still open"
          : `Period return ${percentText(periodReturnBps)}, verified on Base`}
      </Typography>
      <View className="flex-row flex-wrap items-center gap-x-4">
        <LikeButton
          strategyId={strategyId}
          seq={seq}
          liked={liked}
          count={likes}
          subject={subject}
        />
        <CommentCount count={comments} subject={subject} onPress={onOpenComments} />
        {commitTx && (
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(BASESCAN + commitTx)}
          >
            <Typography variant="micro" className="underline">
              Sealed tx
            </Typography>
          </Pressable>
        )}
        {revealTx && (
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(BASESCAN + revealTx)}
          >
            <Typography variant="micro" className="underline">
              Reveal tx
            </Typography>
          </Pressable>
        )}
      </View>
    </View>
  );
}
