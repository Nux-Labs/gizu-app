import { useState } from "react";
import { TextInput, View } from "react-native";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import type { StrategyComment } from "@/domain/strategies";
import { agoText } from "@/domain/strategyProfile";
import colors from "@/theme/colors.json";
import { useComments, useSocialSession, useStrategySocialDeps } from "../useStrategySocial";

const MAX_COMMENT = 500;
const inputClass = "min-h-12 rounded-xl bg-well px-4 py-3 text-text";

function Composer({
  placeholder,
  label,
  busy,
  onSubmit,
}: {
  placeholder: string;
  label: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const trimmed = body.trim();
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={label}
        placeholder={placeholder}
        placeholderTextColor={colors.fg["35"]}
        value={body}
        onChangeText={setBody}
        maxLength={MAX_COMMENT}
        multiline
        editable={!busy}
        className={inputClass}
      />
      <View className="flex-row items-center justify-between">
        <Typography variant="micro">
          {trimmed.length > 0 ? `${trimmed.length}/${MAX_COMMENT}` : ""}
        </Typography>
        <Button
          label="Post"
          variant="secondary"
          disabled={trimmed.length === 0 || busy}
          loading={busy}
          onPress={async () => {
            if (await onSubmit(trimmed)) setBody("");
          }}
        />
      </View>
    </View>
  );
}

function CommentRow({
  comment,
  canHide,
  nowMs,
  onReply,
  onDelete,
  onReport,
  onHide,
}: {
  comment: StrategyComment;
  canHide: boolean;
  nowMs: number;
  onReply?: () => void;
  onDelete: () => void;
  onReport: () => void;
  onHide: () => void;
}) {
  return (
    <View accessibilityLabel={`Comment by ${comment.authorName}`} className="gap-1">
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Typography variant="rowTitle" className={comment.owner ? "!text-accent" : ""}>
          {comment.authorName}
        </Typography>
        {comment.owner && <Typography variant="micro">Owner</Typography>}
        <Typography variant="micro">{agoText(comment.createdAt, nowMs)}</Typography>
      </View>
      <Typography variant="rowValue">{comment.body}</Typography>
      <View className="flex-row flex-wrap gap-x-1">
        {onReply && <Button label="Reply" variant="quiet" onPress={onReply} />}
        {comment.mine ? (
          <Button label="Delete" variant="quiet" onPress={onDelete} />
        ) : (
          <>
            {canHide && <Button label="Hide" variant="quiet" onPress={onHide} />}
            <Button label="Report" variant="quiet" onPress={onReport} />
          </>
        )}
      </View>
    </View>
  );
}

/**
 * A comment thread with one level of replies. Writing asks to sign in once; everyone appears under
 * an automatic nickname, and the strategy's owner under its name.
 */
export function CommentsSection({
  strategyId,
  seq,
  title = "Comments",
}: {
  strategyId: number;
  seq: number | null;
  title?: string;
}) {
  const { now } = useStrategySocialDeps();
  const thread = useComments(strategyId, seq);
  const { session, available } = useSocialSession();
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const canHide = session?.ownerOf === strategyId;
  const nowMs = now();
  const subject = seq === null ? "this strategy" : `update ${seq}`;

  return (
    <View className="gap-3">
      <Typography variant="section">{title}</Typography>
      {available ? (
        <>
          <Composer
            label={`Comment on ${subject}`}
            placeholder={session ? `Comment as ${session.name}` : "Add a comment"}
            busy={thread.posting && replyTo === null}
            onSubmit={(body) => thread.post(body, null)}
          />
          {!session && (
            <Typography variant="micro">
              Posting signs you in once with your passkey. You appear under an automatic nickname;
              your wallet stays private.
            </Typography>
          )}
        </>
      ) : (
        <Typography variant="micro">
          Commenting needs the Gizu Android app with a wallet.
        </Typography>
      )}
      {thread.actionError && <Notice error message={thread.actionError} />}
      {thread.error && <Notice error message={thread.error} />}
      {thread.loading && thread.list.length === 0 && (
        <Typography variant="micro" accessibilityLiveRegion="polite">
          Loading comments…
        </Typography>
      )}
      {!thread.loading && !thread.error && thread.list.length === 0 && (
        <Typography variant="rowValue" className="!text-fg-45">
          No comments yet.
        </Typography>
      )}
      <View className="gap-4">
        {thread.list.map((comment) => (
          <View key={comment.id} className="gap-3">
            <CommentRow
              comment={comment}
              canHide={canHide}
              nowMs={nowMs}
              onReply={
                available ? () => setReplyTo(replyTo === comment.id ? null : comment.id) : undefined
              }
              onDelete={() => void thread.remove(comment.id)}
              onReport={() => void thread.report(comment.id)}
              onHide={() => void thread.hide(comment.id)}
            />
            {(comment.replies.length > 0 || replyTo === comment.id) && (
              <View className="ml-4 gap-3 border-l border-glassBorder pl-3">
                {comment.replies.map((reply) => (
                  <CommentRow
                    key={reply.id}
                    comment={reply}
                    canHide={canHide}
                    nowMs={nowMs}
                    onDelete={() => void thread.remove(reply.id)}
                    onReport={() => void thread.report(reply.id)}
                    onHide={() => void thread.hide(reply.id)}
                  />
                ))}
                {replyTo === comment.id && (
                  <Composer
                    label={`Reply to ${comment.authorName}`}
                    placeholder={`Reply to ${comment.authorName}`}
                    busy={thread.posting}
                    onSubmit={async (body) => {
                      const ok = await thread.post(body, comment.id);
                      if (ok) setReplyTo(null);
                      return ok;
                    }}
                  />
                )}
              </View>
            )}
          </View>
        ))}
      </View>
      {thread.next && (
        <Button
          label="Show more comments"
          variant="quiet"
          disabled={thread.loading}
          onPress={() => void thread.loadMore()}
        />
      )}
    </View>
  );
}
