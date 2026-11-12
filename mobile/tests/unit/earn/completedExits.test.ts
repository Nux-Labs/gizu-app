import { createCompletedExitsStore } from "@/storage/completedExits";
import { hoodIntent } from "../../support/robinhoodEarn";

function storage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: async (key: string) => rows.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: async (key: string) => {
      rows.delete(key);
    },
  };
}
test("completed observations survive adapter recreation and bind exact wallet, intent, profile, slot and revisions", async () => {
  const io = storage();
  await createCompletedExitsStore(io).save(hoodIntent, "native-revisions");
  const reopened = createCompletedExitsStore(io);
  expect(await reopened.has(hoodIntent, "native-revisions")).toBe(true);
  expect(await reopened.has(hoodIntent, "new-native-revisions")).toBe(false);
  for (const intent of [
    { ...hoodIntent, walletId: "another-wallet" },
    { ...hoodIntent, intentId: "another-intent" },
    { ...hoodIntent, profileId: "ethereum-usdc" as const },
    { ...hoodIntent, investmentSlot: 0 },
  ])
    expect(await reopened.has(intent, "native-revisions")).toBe(false);
  await reopened.forget(hoodIntent);
  expect(await reopened.has(hoodIntent, "native-revisions")).toBe(false);
});
test("corrupt or oversized observations never count as completed", async () => {
  const io = storage();
  const history = createCompletedExitsStore(io);
  await history.save(hoodIntent, "revision");
  const key = [...io.rows.keys()][0]!;
  for (const raw of [
    "bad-json",
    "null",
    JSON.stringify({ version: 2, revision: "revision" }),
    "x".repeat(125001),
  ]) {
    io.rows.set(key, raw);
    expect(await history.has(hoodIntent, "revision")).toBe(false);
  }
  await history.save(hoodIntent, "x".repeat(120001));
  expect(await history.has(hoodIntent, "x".repeat(120001))).toBe(false);
});
test("unavailable observation storage falls back safely while a failed explicit reset is reported", async () => {
  const unavailable = async () => {
    throw Error("Storage unavailable");
  };
  const history = createCompletedExitsStore({
    getItem: unavailable,
    setItem: unavailable,
    removeItem: unavailable,
  });
  expect(await history.has(hoodIntent, "revision")).toBe(false);
  await expect(history.save(hoodIntent, "revision")).resolves.toBeUndefined();
  await expect(history.forget(hoodIntent)).rejects.toThrow("Storage unavailable");
});
