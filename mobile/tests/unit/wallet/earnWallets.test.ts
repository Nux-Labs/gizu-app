import { createEarnWalletService } from "@/services/wallet/earnWallets";

const walletId = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12";
const source = "0x" + "1".repeat(40);
const descriptor = {
  status: "prepared",
  version: "gizu-earn-v1",
  walletId,
  intentId: `earn-v1:${walletId}:ethereum-usdc`,
  profileId: "ethereum-usdc",
  sourceAddress: source,
  confidentialAddress: "0x" + "4".repeat(40),
  sourceChainId: 143,
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: "0x" + "3".repeat(40), chainId: 1 },
  ],
};
function setup() {
  const native = {
    getEarnIntent: jest.fn().mockResolvedValue(descriptor),
    prepareEarnIntent: jest.fn().mockResolvedValue(descriptor),
    lock: jest.fn(),
  };
  return {
    native,
    service: createEarnWalletService(() => native),
    owner: { walletId, address: source },
  };
}
test("native shared return identity survives decoding and cannot alias a public destination", async () => {
  const { native, service, owner } = setup();
  const shared = "0x" + "8".repeat(40);
  native.getEarnIntent.mockResolvedValue({ ...descriptor, returnConfidentialAddress: shared });
  expect(await service.load(owner)).toMatchObject({ returnConfidentialAddress: shared });
  native.getEarnIntent.mockResolvedValue({
    ...descriptor,
    returnConfidentialAddress: descriptor.destinations[1]!.address,
  });
  await expect(service.load(owner)).rejects.toThrow();
});

test("native intent returns two bound public destinations without any signing call", async () => {
  const { native, service, owner } = setup();
  expect(await service.prepare(owner, "ethereum-usdc")).toEqual(descriptor);
  expect(native.prepareEarnIntent).toHaveBeenCalledWith(walletId, "ethereum-usdc");
  expect(await service.load(owner)).toEqual(descriptor);
  expect(native.getEarnIntent).toHaveBeenCalledWith(walletId);
});
test.each([
  { walletId: "other" },
  { sourceAddress: "0x" + "4".repeat(40) },
  { sourceChainId: 10143 },
  { profileId: "arbitrary" },
  { backupCovered: false },
  { version: "other" },
  { intentId: "other" },
  { destinations: [] },
  { destinations: [...descriptor.destinations, descriptor.destinations[0]] },
  { destinations: descriptor.destinations.map((d) => ({ ...d, role: "hold" })) },
  { destinations: descriptor.destinations.map((d) => ({ ...d, address: source })) },
  { destinations: descriptor.destinations.map((d) => ({ ...d, chainId: 143 })) },
])("rejects malformed or changed native bindings %j", async (change) => {
  const { native, service, owner } = setup();
  native.prepareEarnIntent.mockResolvedValue({ ...descriptor, ...change });
  await expect(service.prepare(owner, "ethereum-usdc")).rejects.toThrow();
});
test("rejects a different supported profile returned for preparation", async () => {
  const { service, owner } = setup();
  await expect(service.prepare(owner, "robinhood-usdg")).rejects.toThrow();
});
test("restore can expose a recovered pair without claiming it is safe to fund", async () => {
  const { native, service, owner } = setup();
  native.getEarnIntent.mockResolvedValue({ status: "recoveryRequired" });
  expect(await service.load(owner)).toEqual({ status: "recoveryRequired" });
  native.prepareEarnIntent.mockResolvedValue({ ...descriptor, status: "recoveryRequired" });
  expect((await service.prepare(owner, "ethereum-usdc")).status).toBe("recoveryRequired");
});
test("old native builds fail closed and cancellation discards a late creation result", async () => {
  const { native, service, owner } = setup();
  await expect(createEarnWalletService(() => null).load(owner)).rejects.toThrow(/native build/);
  let resolve!: (value: typeof descriptor) => void;
  native.prepareEarnIntent.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = service.prepare(owner, "ethereum-usdc");
  service.cancel();
  resolve(descriptor);
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(native.lock).toHaveBeenCalledTimes(1);
});

test("native source can differ from the displayed account while preserving wallet identity", async () => {
  const { native, service, owner } = setup();
  const sourceAddress = "0x" + "5".repeat(40);
  native.getEarnIntent.mockResolvedValue({ ...descriptor, sourceAddress });
  expect(await service.load(owner)).toEqual({ ...descriptor, sourceAddress });
});

test("new native cycles have a distinct validated wallet-bound identity", async () => {
  const { native, owner } = setup();
  const cycle = {
    ...descriptor,
    version: "gizu-earn-v2",
    cycleIndex: 2,
    intentId: `earn-v2:${walletId}:ethereum-usdc:2`,
  };
  const bridge = {
    ...native,
    prepareNewEarnIntent: jest.fn().mockResolvedValue(cycle),
    listEarnIntents: jest.fn().mockResolvedValue([descriptor, cycle]),
    selectEarnIntent: jest.fn().mockResolvedValue(cycle),
  };
  const service = createEarnWalletService(() => bridge);
  expect(await service.prepareNew!(owner, "ethereum-usdc")).toEqual(cycle);
  expect(await service.list!(owner)).toEqual([descriptor, cycle]);
  expect(await service.select!(owner, cycle.intentId)).toEqual(cycle);
  bridge.selectEarnIntent.mockResolvedValue(descriptor);
  await expect(service.select!(owner, cycle.intentId)).rejects.toThrow(/cycle changed/);
});
