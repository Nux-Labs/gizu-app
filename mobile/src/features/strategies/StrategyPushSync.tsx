import { useEffect } from "react";
import { enableStrategyPush } from "@/services/strategyPush";
import { useStrategyFollowerDeps } from "./useStrategyFollower";

/**
 * Once per launch, a phone with update notifications on registers its current push token again
 * and re-follows its strategies. Tokens rotate and the backend drops dead ones; registering never
 * asks for permission here.
 */
export function StrategyPushSync() {
  const { follows, push } = useStrategyFollowerDeps();
  useEffect(() => {
    void (async () => {
      if (!(await follows.pushDevice())) return;
      const ids = (await follows.load()).map((follow) => follow.strategyId);
      const result = await enableStrategyPush({ ...push, store: follows }, ids, false);
      // Permission was withdrawn in Settings: stop claiming notifications are on.
      if (result === "denied") await follows.setPushDevice(null);
    })().catch(() => undefined);
  }, [follows, push]);
  return null;
}
