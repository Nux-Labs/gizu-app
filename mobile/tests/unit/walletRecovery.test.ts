import { parseWalletRecoveryStatus, recoveryScanBound } from "@/domain/wallet/recovery";

const snapshot = {
  version: 1,
  phase: "ready",
  revision: 4,
  synced: true,
  scannedThroughCycle: 12,
  scanTargetCycle: 30,
  discoveredWallets: 8,
  recoveryRequired: true,
};

test("only public recovery progress crosses the service boundary", () => {
  expect(parseWalletRecoveryStatus({ ...snapshot, address: "private", bearer: "secret" })).toEqual(
    snapshot,
  );
});

test.each([
  { version: 2 },
  { phase: "complete" },
  { revision: -1 },
  { synced: "yes" },
  { scannedThroughCycle: -2 },
  { scanTargetCycle: 1_000_001 },
  { discoveredWallets: 0.5 },
  { recoveryRequired: undefined },
  { scannedThroughCycle: 31 },
  { revision: 0 },
])("malformed native recovery progress is rejected: %p", (change) => {
  expect(() => parseWalletRecoveryStatus({ ...snapshot, ...change })).toThrow(/recovery/i);
});

test("initial recovery counters support an unstarted scan", () => {
  expect(
    parseWalletRecoveryStatus({
      ...snapshot,
      phase: "idle",
      revision: 0,
      synced: false,
      scannedThroughCycle: -1,
      scanTargetCycle: -1,
    }),
  ).toEqual({
    ...snapshot,
    phase: "idle",
    revision: 0,
    synced: false,
    scannedThroughCycle: -1,
    scanTargetCycle: -1,
  });
});

test("only known recovery message codes survive decoding", () => {
  expect(
    parseWalletRecoveryStatus({ ...snapshot, messageCode: "raw provider secret" }).messageCode,
  ).toBeUndefined();
  expect(
    parseWalletRecoveryStatus({ ...snapshot, messageCode: "reconciliationRequired" }).messageCode,
  ).toBe("reconciliationRequired");
});

test("scan bounds are explicit inclusive integers with no gap-limit completion claim", () => {
  expect(recoveryScanBound("256")).toBe(256);
  expect(recoveryScanBound("0")).toBe(0);
  for (const invalid of ["", "-1", "2.5", "1e3", "1000001", " 12 ", "03"])
    expect(recoveryScanBound(invalid)).toBeNull();
});
