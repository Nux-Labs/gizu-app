import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EarnIntent } from "@/domain/earn/types";

type Storage = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;
const validRevision = (value: string) => value.length > 0 && value.length <= 120000;

/** Historical UI observations only. Never a balance, signing lease or spending authority. */
export function createCompletedExitsStore(storage: Storage = AsyncStorage) {
  const key = (intent: EarnIntent) =>
    "gizu:completed-exit:v1:" +
    [intent.walletId, intent.profileId, intent.intentId, intent.investmentSlot ?? "legacy"]
      .map((part) => encodeURIComponent(String(part)))
      .join(":");
  return {
    async has(intent: EarnIntent, revision: string): Promise<boolean> {
      if (!validRevision(revision)) return false;
      try {
        const raw = await storage.getItem(key(intent));
        if (!raw || raw.length > 125000) return false;
        const value = JSON.parse(raw);
        return value?.version === 1 && value.revision === revision;
      } catch {
        return false;
      }
    },
    async save(intent: EarnIntent, revision: string): Promise<void> {
      if (!validRevision(revision)) return;
      try {
        await storage.setItem(key(intent), JSON.stringify({ version: 1, revision }));
      } catch {
        // Missing observation storage never changes native execution or reconciliation.
      }
    },
    async forget(intent: EarnIntent): Promise<void> {
      // Explicit rechecks must not silently keep using an observation that could not be cleared.
      await storage.removeItem(key(intent));
    },
  };
}
export const completedExitsStore = createCompletedExitsStore();
