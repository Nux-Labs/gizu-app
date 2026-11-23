import * as SecureStore from "expo-secure-store";

/** The holdings a strategy's last basket was sealed from; stays on this phone. */
export type SealRecord = { strategyId: number; sealedAt: string; amounts: Record<string, string> };

export interface SealRecordStore {
  load(strategyId: number): Promise<SealRecord | null>;
  save(record: SealRecord): Promise<void>;
}

const key = (strategyId: number) => `gizu.strategies.sealed-holdings.v1.${strategyId}`;

function isRecord(value: unknown, strategyId: number): value is SealRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.strategyId === strategyId &&
    typeof record.sealedAt === "string" &&
    !!record.amounts &&
    typeof record.amounts === "object" &&
    Object.values(record.amounts as object).every(
      (amount) => typeof amount === "string" && /^\d+$/.test(amount),
    )
  );
}

/** Amounts are private, so they live in the keystore like follows and the social session. */
export const secureSealRecordStore: SealRecordStore = {
  async load(strategyId) {
    try {
      const raw = await SecureStore.getItemAsync(key(strategyId));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isRecord(parsed, strategyId) ? parsed : null;
    } catch {
      return null;
    }
  },
  async save(record) {
    await SecureStore.setItemAsync(key(record.strategyId), JSON.stringify(record));
  },
};

export function createMemorySealRecordStore(initial: SealRecord[] = []): SealRecordStore {
  const records = new Map(initial.map((record) => [record.strategyId, record]));
  return {
    async load(strategyId) {
      return records.get(strategyId) ?? null;
    },
    async save(record) {
      records.set(record.strategyId, record);
    },
  };
}
