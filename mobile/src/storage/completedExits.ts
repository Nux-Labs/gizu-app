import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EarnIntent } from "@/domain/earn/types";

type Storage = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;
const validRevision = (value: string) => value.length > 0 && value.length <= 120000;
type PositionIdentity = Pick<EarnIntent, "walletId" | "profileId" | "intentId" | "investmentSlot">;

/** Historical UI observations only. Never a balance, signing lease or spending authority. */
export function createCompletedExitsStore(storage: Storage = AsyncStorage) {
  const key = (intent: PositionIdentity) =>
    "gizu:completed-exit:v1:" +
    [intent.walletId, intent.profileId, intent.intentId, intent.investmentSlot ?? "legacy"]
      .map((part) => encodeURIComponent(String(part)))
      .join(":");
  return {
    async hasReturn(intent: PositionIdentity, operationId: string): Promise<boolean> {
      try {
        const raw = await storage.getItem(key(intent));
        if (!raw || raw.length > 125000) return false;
        const value = JSON.parse(raw);
        if (
          value?.version !== 1 ||
          typeof value.revision !== "string" ||
          !validRevision(value.revision)
        )
          return false;
        const history = JSON.parse(value.revision);
        if (
          !Array.isArray(history) ||
          history.length !== 2 ||
          history.some((item) => typeof item !== "string")
        )
          return false;
        const journal = JSON.parse(history[0]),
          payouts = JSON.parse(history[1]);
        const finishedEntry = (row: unknown): row is [string, number, string, false] =>
          Array.isArray(row) &&
          row.length === 4 &&
          typeof row[0] === "string" &&
          /^[-a-zA-Z0-9_]{1,128}$/.test(row[0]) &&
          Number.isSafeInteger(row[1]) &&
          row[1] > 0 &&
          typeof row[2] === "string" &&
          row[3] === false;
        return (
          Array.isArray(journal) &&
          Array.isArray(payouts) &&
          journal.every(finishedEntry) &&
          payouts.every((row) => finishedEntry(row) && ["paid", "cancelled"].includes(row[2])) &&
          journal.some(
            (row) => row[0] === operationId && ["credited", "minimumReceived"].includes(row[2]),
          )
        );
      } catch {
        return false;
      }
    },
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
