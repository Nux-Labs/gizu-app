import { createWalletRecoveryService } from "@/services/wallet/recovery";

const status = {
  version: 1,
  phase: "idle",
  revision: 0,
  synced: false,
  scannedThroughCycle: -1,
  scanTargetCycle: -1,
  discoveredWallets: 0,
  recoveryRequired: false,
};
function setup() {
  const native = {
    getWalletRecoveryStatus: jest.fn().mockResolvedValue(status),
    syncWalletRecovery: jest
      .fn()
      .mockResolvedValue({ ...status, phase: "ready", revision: 1, synced: true }),
    restoreWalletRecovery: jest.fn().mockResolvedValue({ ...status, recoveryRequired: true }),
    discoverWallets: jest
      .fn()
      .mockResolvedValue({ ...status, phase: "discovering", scanTargetCycle: 256 }),
    cancelWalletDiscovery: jest.fn().mockResolvedValue({ ...status, phase: "paused" }),
  };
  const service = createWalletRecoveryService(
    () => native,
    async () => ({ walletRecovery: true, walletDiscovery: true }),
  );
  return { service, native };
}
test("recovery actions carry only the current wallet ID and an explicit scan bound", async () => {
  const { service, native } = setup();
  await expect(service.available()).resolves.toEqual({ recovery: true, discovery: true });
  await expect(service.sync("wallet")).resolves.toEqual({
    ...status,
    phase: "ready",
    revision: 1,
    synced: true,
  });
  await service.restore("wallet");
  await service.discover("wallet", 256);
  await service.cancel("wallet");
  expect(native.syncWalletRecovery).toHaveBeenCalledWith("wallet");
  expect(native.restoreWalletRecovery).toHaveBeenCalledWith("wallet");
  expect(native.discoverWallets).toHaveBeenCalledWith("wallet", 256);
  expect(native.cancelWalletDiscovery).toHaveBeenCalledWith("wallet");
});
test("missing native capabilities do not offer recovery or discovery", async () => {
  await expect(
    createWalletRecoveryService(
      () => null,
      async () => ({}),
    ).available(),
  ).resolves.toEqual({ recovery: false, discovery: false });
});
test("invalid scan requests cannot reach native discovery", async () => {
  const { service, native } = setup();
  for (const bound of [-1, 1.5, 1_000_001, Infinity])
    await expect(service.discover("wallet", bound)).rejects.toThrow();
  await expect(service.sync("")).rejects.toThrow();
  expect(native.discoverWallets).not.toHaveBeenCalled();
  expect(native.syncWalletRecovery).not.toHaveBeenCalled();
});
test("provider errors and unexpected native payloads never reach recovery UI", async () => {
  const { service, native } = setup();
  native.syncWalletRecovery.mockRejectedValue(
    new Error("Bearer secret 0x1111111111111111111111111111111111111111"),
  );
  await expect(service.sync("wallet")).rejects.toThrow(
    "Wallet recovery is unavailable. Check your connection and try again.",
  );
  native.getWalletRecoveryStatus.mockResolvedValue({ ...status, revision: -1 });
  await expect(service.status("wallet")).rejects.toThrow(/recovery/);
});
