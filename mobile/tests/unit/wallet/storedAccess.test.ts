import { createStoredWalletAccess } from "@/services/wallet/storedAccess";
import type { StoredWalletState } from "@/domain/wallet/storedSigner";
import { deferred } from "../../support/renderApp";
const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const pending: StoredWalletState = { status: "backupRequired", walletId };
const ready: StoredWalletState = {
  status: "ready",
  walletId,
  accounts: [{ accountIndex: 0, address: "0x" + "1".repeat(40), chainId: 10143 }],
};
function setup(state: StoredWalletState = { status: "absent" }) {
  const native = {
    getWalletState: jest.fn().mockResolvedValue(state),
    createWallet: jest.fn().mockResolvedValue(pending),
    backupWallet: jest.fn().mockResolvedValue(ready),
    openWallet: jest.fn().mockResolvedValue(ready),
    restoreWallet: jest.fn().mockResolvedValue(ready),
    getSwapDeposit: jest.fn().mockResolvedValue({ fundingAddress: "0x" + "1".repeat(40) }),
    lock: jest.fn(),
  };
  return { native, service: createStoredWalletAccess(() => native) };
}
test("cancel during creation cannot start a later backup ceremony", async () => {
  const { native, service } = setup();
  const creation = deferred<StoredWalletState>();
  native.createWallet.mockReturnValue(creation.promise);
  const result = service.request("Passkey");
  await Promise.resolve();
  await Promise.resolve();
  service.cancel?.();
  creation.resolve(pending);
  await expect(result).rejects.toThrow("Cancelled");
  expect(native.backupWallet).not.toHaveBeenCalled();
});
test("ready metadata requires fresh native access before returning a public session", async () => {
  const { native, service } = setup(ready);
  const result = await service.request("Passkey");
  expect(native.openWallet).toHaveBeenCalledTimes(1);
  expect(native.backupWallet).not.toHaveBeenCalled();
  expect(result).toEqual({
    kind: "mainnet",
    method: "Passkey",
    walletId,
    address: "0x" + "1".repeat(40),
    accountId: "0x" + "1".repeat(40),
    accountIndex: 1,
    chainId: 143,
  });
});
test.each([pending, { status: "recoveryRequired" } as StoredWalletState])(
  "incomplete state cannot become a session: %j",
  async (state) => {
    const { native, service } = setup(state);
    native.backupWallet.mockResolvedValue(state);
    await expect(service.request("Passkey")).rejects.toThrow();
    expect(native.createWallet).not.toHaveBeenCalled();
  },
);
test("local wallet status reflects native storage health", async () => {
  const { native, service } = setup();
  expect(await service.localWallet?.()).toBe("absent");
  native.getWalletState.mockResolvedValue(pending);
  expect(await service.localWallet?.()).toBe("present");
  native.getWalletState.mockResolvedValue({ status: "recoveryRequired" });
  expect(await service.localWallet?.()).toBe("unreadable");
});
