import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { ApiError, sendJson } from "./http";
import type { StrategyFollowStore } from "./strategyFollows";

/** Android channel the backend addresses strategy updates to. */
export const STRATEGY_PUSH_CHANNEL = "strategy-updates";
const UNAVAILABLE = "Notifications are unavailable right now.";

export interface StrategyPushApi {
  register(token: string, platform: "android" | "ios"): Promise<string>;
  /** False when the backend no longer knows the device or the strategy. */
  follow(deviceId: string, strategyId: number): Promise<boolean>;
  remove(deviceId: string): Promise<void>;
}

export function createStrategyPushApi(baseUrl: string): StrategyPushApi {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async register(token, platform) {
      const body = await sendJson(
        "POST",
        `${base}/v1/push/devices`,
        { token, platform },
        { unavailable: UNAVAILABLE },
      );
      const deviceId = (body as { deviceId?: unknown } | null)?.deviceId;
      if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/.test(deviceId))
        throw new Error(UNAVAILABLE);
      return deviceId;
    },
    async follow(deviceId, strategyId) {
      try {
        await sendJson(
          "PUT",
          `${base}/v1/push/devices/${deviceId}/strategies/${strategyId}`,
          undefined,
          {
            unavailable: UNAVAILABLE,
          },
        );
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
    },
    async remove(deviceId) {
      await sendJson("DELETE", `${base}/v1/push/devices/${deviceId}`, undefined, {
        unavailable: UNAVAILABLE,
      });
    },
  };
}

/** The phone's side: permission and the FCM token. */
export interface PushPlatform {
  /**
   * The device push token; "denied" when the person said no, null when this build cannot receive
   * notifications (no Firebase config, iOS, or a simulator). `prompt: false` never asks.
   */
  token(options: { prompt: boolean }): Promise<string | "denied" | null>;
}

export const nativePushPlatform: PushPlatform = {
  async token({ prompt }) {
    if (Platform.OS !== "android") return null;
    try {
      await Notifications.setNotificationChannelAsync(STRATEGY_PUSH_CHANNEL, {
        name: "Strategy updates",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && prompt && permission.canAskAgain)
        permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) return "denied";
      const token = await Notifications.getDevicePushTokenAsync();
      return typeof token.data === "string" && token.data.length >= 16 ? token.data : null;
    } catch {
      // Builds without google-services.json cannot fetch an FCM token.
      return null;
    }
  },
};

export type PushResult = "enabled" | "denied" | "unavailable";

/**
 * Registers this phone and follows `strategyIds`. A registration replaces the phone's previous
 * device and its follows on the backend, so every followed strategy is followed again.
 */
export async function enableStrategyPush(
  deps: { api: StrategyPushApi; platform: PushPlatform; store: StrategyFollowStore },
  strategyIds: readonly number[],
  prompt: boolean,
): Promise<PushResult> {
  const token = await deps.platform.token({ prompt });
  if (token === "denied") return "denied";
  if (token === null) return "unavailable";
  const deviceId = await deps.api.register(token, Platform.OS === "ios" ? "ios" : "android");
  await deps.store.setPushDevice(deviceId);
  for (const id of strategyIds) await deps.api.follow(deviceId, id);
  return "enabled";
}

/** Follows one more strategy on an enabled phone; re-registers when the backend forgot the device. */
export async function followStrategyPush(
  deps: { api: StrategyPushApi; platform: PushPlatform; store: StrategyFollowStore },
  strategyId: number,
): Promise<PushResult> {
  const deviceId = await deps.store.pushDevice();
  if (deviceId && (await deps.api.follow(deviceId, strategyId))) return "enabled";
  const ids = (await deps.store.load()).map((follow) => follow.strategyId);
  return enableStrategyPush(deps, ids.includes(strategyId) ? ids : [...ids, strategyId], !deviceId);
}

/**
 * The strategy a notification is about. Notifications carry `sha256(deviceId:strategyId)` instead
 * of the id, so the push provider cannot tell which strategy a phone follows.
 */
export function strategyForPushRef(
  ref: string,
  deviceId: string,
  strategyIds: readonly number[],
): number | null {
  return (
    strategyIds.find(
      (id) => bytesToHex(sha256(utf8ToBytes(`${deviceId}:${id}`))).slice(0, 32) === ref,
    ) ?? null
  );
}

export const strategyPushApi = createStrategyPushApi(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
