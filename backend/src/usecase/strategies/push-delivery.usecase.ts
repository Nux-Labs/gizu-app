import { createHash } from "node:crypto";
import type { PushSender, StrategyStore } from "../../ports/strategies.port.ts";

const BATCH = 50;

/**
 * The reference a notification carries instead of the strategy id: the push provider sees a value
 * that differs per device, and the app recomputes it for the strategies it follows.
 */
export function pushRef(deviceId: string, strategyId: number): string {
  return createHash("sha256").update(`${deviceId}:${strategyId}`).digest("hex").slice(0, 32);
}

export type PushLog = (event: {
  code: "PUSH_FAILED" | "PUSH_DEVICE_UNREGISTERED" | "PUSH_PROVIDER_UNAVAILABLE";
  strategyId: number;
}) => void;

/** Sends queued strategy notifications, one per device and strategy, from the worker. */
export class PushDelivery {
  constructor(
    private readonly store: Pick<
      StrategyStore,
      "pendingPushes" | "finishPush" | "removePushDevice" | "withWorkerLock"
    >,
    private readonly sender: PushSender,
    private readonly log: PushLog = () => {},
  ) {}

  async runOnce(): Promise<void> {
    await this.store.withWorkerLock(async () => {
      for (const push of await this.store.pendingPushes(BATCH)) {
        let outcome;
        try {
          outcome = await this.sender.send({
            token: push.token,
            platform: push.platform,
            ref: pushRef(push.deviceId, push.strategyId),
          });
        } catch {
          // The provider is unreachable: everything stays queued for the next run.
          this.log({ code: "PUSH_PROVIDER_UNAVAILABLE", strategyId: push.strategyId });
          return;
        }
        if (outcome === "unregistered") {
          await this.store.removePushDevice(push.deviceId);
          this.log({ code: "PUSH_DEVICE_UNREGISTERED", strategyId: push.strategyId });
          continue;
        }
        await this.store.finishPush(push, outcome);
        if (outcome === "failed") this.log({ code: "PUSH_FAILED", strategyId: push.strategyId });
      }
    });
  }
}
