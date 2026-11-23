import { Pressable, View } from "react-native";
import { Heart, MessageCircle } from "lucide-react-native";
import { Typography } from "@/components/atoms/Typography";
import colors from "@/theme/colors.json";
import { useLike } from "../useStrategySocial";

/** A like toggle with its count; the first like asks to sign in. */
export function LikeButton({
  strategyId,
  seq,
  liked,
  count,
  subject,
}: {
  strategyId: number;
  seq: number | null;
  liked: boolean;
  count: number;
  /** What is liked, for screen readers: "AI chips" or "update 3". */
  subject: string;
}) {
  const like = useLike(strategyId, seq, { liked, count });
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${like.liked ? "Unlike" : "Like"} ${subject}`}
        accessibilityState={{ selected: like.liked, busy: like.busy }}
        hitSlop={8}
        onPress={() => void like.toggle()}
        className="min-h-9 flex-row items-center gap-1.5 self-start rounded-full px-1"
      >
        <Heart
          size={17}
          color={like.liked ? colors.danger : colors.fg["45"]}
          fill={like.liked ? colors.danger : "transparent"}
        />
        <Typography variant="rowValue" accessibilityLabel={`${like.count} likes`}>
          {like.count}
        </Typography>
      </Pressable>
      {like.error && (
        <Typography variant="micro" className="!text-danger">
          {like.error}
        </Typography>
      )}
    </View>
  );
}

/** A comment count that opens the thread. */
export function CommentCount({
  count,
  subject,
  onPress,
}: {
  count: number;
  subject: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} comments on ${subject}`}
      hitSlop={8}
      onPress={onPress}
      className="min-h-9 flex-row items-center gap-1.5 self-start rounded-full px-1"
    >
      <MessageCircle size={17} color={colors.fg["45"]} />
      <Typography variant="rowValue">{count}</Typography>
    </Pressable>
  );
}
