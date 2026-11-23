import { useEffect, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "@/components/atoms/Button";
import { Typography } from "@/components/atoms/Typography";
import { Notice } from "@/components/molecules/Notice";
import { Screen } from "@/components/templates/Screen";
import type { StrategyDetail } from "@/domain/strategies";
import { revealedUpdates } from "@/domain/strategyProfile";
import { BackAction } from "@/navigation/BackAction";
import type { RootStackParamList } from "@/navigation/types";
import { strategyErrorMessage } from "@/services/strategies";
import { CommentsSection } from "./components/CommentsSection";
import { UpdateCard } from "./components/UpdateCard";
import { useStrategyFollowerDeps } from "./useStrategyFollower";
import { useSocialSession, useStrategySocialDeps } from "./useStrategySocial";

type Props = NativeStackScreenProps<RootStackParamList, "StrategyUpdate">;

/** One revealed update with its changes, its likes and its own comment thread. */
export function StrategyUpdateScreen({ route, navigation }: Props) {
  const id = Number(route.params.id);
  const seq = Number(route.params.seq);
  const { service } = useStrategyFollowerDeps();
  const { now } = useStrategySocialDeps();
  const { session, loaded } = useSocialSession();
  const token = session?.token ?? null;
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    service
      .detail(id, controller.signal, token)
      .then((found) => {
        setDetail(found);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(strategyErrorMessage(cause));
      });
    return () => controller.abort();
  }, [id, loaded, revision, service, token]);

  const update = detail
    ? revealedUpdates(detail.history).find(({ entry }) => entry.seq === seq)
    : undefined;
  return (
    <Screen>
      <BackAction fallback="Home" />
      {error && (
        <>
          <Notice error message={error} />
          <Button label="Try again" onPress={() => setRevision((value) => value + 1)} />
        </>
      )}
      {!detail && !error && (
        <Typography accessibilityLiveRegion="polite">Loading update…</Typography>
      )}
      {detail && !update && <Notice error message="This update isn't revealed yet." />}
      {detail && update && (
        <>
          <UpdateCard
            strategyId={detail.id}
            strategyName={detail.name}
            seq={seq}
            at={update.entry.revealedAt}
            assets={update.entry.assets}
            previous={update.previous}
            periodReturnBps={update.entry.periodReturnBps}
            likes={update.entry.likes}
            comments={update.entry.comments}
            liked={update.entry.liked}
            commitTx={update.entry.commitTx}
            revealTx={update.entry.revealTx}
            nowMs={now()}
            showStrategy
            onOpenStrategy={() => navigation.navigate("StrategyDetail", { id: detail.id })}
            onOpenComments={() => {}}
          />
          <CommentsSection strategyId={detail.id} seq={seq} />
        </>
      )}
    </Screen>
  );
}
