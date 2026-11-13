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

test("a recorded completed return stays done after its receipt revision changes, without completing a later return", async () => {
  const io = storage();
  const completed = createCompletedExitsStore(io);
  // Use the persisted v1 structure produced by exitHistoryRevision, independent of today's balances.
  await completed.save(
    hoodIntent,
    JSON.stringify([JSON.stringify([["return_old", 4, "minimumReceived", false]]), "[]"]),
  );
  expect(await createCompletedExitsStore(io).hasReturn(hoodIntent, "return_old")).toBe(true);
  expect(await completed.hasReturn(hoodIntent, "return_new")).toBe(false);
  expect(
    await completed.hasReturn({ ...hoodIntent, walletId: "another-wallet" }, "return_old"),
  ).toBe(false);
});

test("malformed completion entries and pending payout history cannot close a return", async () => {
  const completed = createCompletedExitsStore(storage());
  for (const [journal, payouts] of [
    [[["return_old", 0, "minimumReceived", false]], []],
    [[["return_old", 4, "minimumReceived", false]], [["payout", 2, "pending", true]]],
  ]) {
    await completed.save(
      hoodIntent,
      JSON.stringify([JSON.stringify(journal), JSON.stringify(payouts)]),
    );
    expect(await completed.hasReturn(hoodIntent, "return_old")).toBe(false);
  }
});
