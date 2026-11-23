import * as SecureStore from "expo-secure-store";

/** A strategy this phone follows. The subscriber key reads its baskets and never leaves the phone otherwise. */
export type FollowedStrategy = {
  strategyId: number;
  name: string;
  subscriberKey: string;
  expiresAt: string;
  /** The basket this phone last copied, so an update shows how far behind it is. */
  copiedSeq: number | null;
};

export interface StrategyFollowStore {
  load(): Promise<FollowedStrategy[]>;
  save(follows: FollowedStrategy[]): Promise<void>;
  /** The push device the backend issued, or null before notifications are turned on. */
  pushDevice(): Promise<string | null>;
  setPushDevice(deviceId: string | null): Promise<void>;
}

const FOLLOWS_KEY = "gizu.strategies.follows.v1";
const DEVICE_KEY = "gizu.strategies.push-device.v1";

function isFollow(value: unknown): value is FollowedStrategy {
  if (!value || typeof value !== "object") return false;
  const follow = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(follow.strategyId) &&
    typeof follow.name === "string" &&
    typeof follow.subscriberKey === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(follow.subscriberKey) &&
    typeof follow.expiresAt === "string" &&
    (follow.copiedSeq === null || Number.isSafeInteger(follow.copiedSeq))
  );
}

/** Follows live in the platform keystore; a damaged entry reads as no follows, never a crash. */
export const secureFollowStore: StrategyFollowStore = {
  async load() {
    try {
      const raw = await SecureStore.getItemAsync(FOLLOWS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isFollow) : [];
    } catch {
      return [];
    }
  },
  async save(follows) {
    await SecureStore.setItemAsync(FOLLOWS_KEY, JSON.stringify(follows));
  },
  async pushDevice() {
    try {
      const value = await SecureStore.getItemAsync(DEVICE_KEY);
      return value && /^[0-9a-f-]{36}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  },
  async setPushDevice(deviceId) {
    if (deviceId) await SecureStore.setItemAsync(DEVICE_KEY, deviceId);
    else await SecureStore.deleteItemAsync(DEVICE_KEY);
  },
};

export function createMemoryFollowStore(initial: FollowedStrategy[] = []): StrategyFollowStore {
  let follows = initial.map((follow) => ({ ...follow }));
  let device: string | null = null;
  return {
    async load() {
      return follows.map((follow) => ({ ...follow }));
    },
    async save(next) {
      follows = next.map((follow) => ({ ...follow }));
    },
    async pushDevice() {
      return device;
    },
    async setPushDevice(deviceId) {
      device = deviceId;
    },
  };
}
