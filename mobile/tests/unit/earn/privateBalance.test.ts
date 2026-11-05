import { createEarnPrivateBalanceService } from "@/services/earn/privateBalance";
import type { EarnIntent } from "@/domain/earn/types";
const intent: EarnIntent & {
  destinations: [EarnIntent["destinations"][0], EarnIntent["destinations"][0]];
} = {
  status: "prepared",
  version: "gizu-earn-v1",
  intentId: "earn-v1:test",
  walletId: "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
  profileId: "ethereum-usdc",
  sourceAddress: "0x" + "1".repeat(40),
  sourceChainId: 143,
  confidentialAddress: "0x" + "4".repeat(40),
  backupCovered: true,
  destinations: [
    { role: "hold", address: "0x" + "2".repeat(40), chainId: 1 },
    { role: "invest", address: "0x" + "3".repeat(40), chainId: 1 },
  ],
};
const result = {
  confidentialAddress: intent.confidentialAddress,
  assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
  available: "1234567",
  timestampMs: 1000000,
  authenticated: true,
  operationScoped: false,
};
beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(1000000));
afterEach(() => jest.restoreAllMocks());
test("native-only authentication exposes an aggregate balance without settlement authority", async () => {
  const native = { readEarnBalance: jest.fn().mockResolvedValue(result), lock: jest.fn() };
  expect(await createEarnPrivateBalanceService(() => native).read(intent)).toEqual(result);
  expect(native.readEarnBalance).toHaveBeenCalledWith(intent.walletId);
});
test.each([
  { confidentialAddress: intent.sourceAddress },
  { available: "1e6" },
  { available: "-1" },
  { timestampMs: 939999 },
  { timestampMs: 1005001 },
  { authenticated: false },
  { operationScoped: true },
  { assetId: "not-an-asset" },
])("rejects changed or stale native private balance %j", async (change) => {
  const native = {
    readEarnBalance: jest.fn().mockResolvedValue({ ...result, ...change }),
    lock: jest.fn(),
  };
  await expect(createEarnPrivateBalanceService(() => native).read(intent)).rejects.toThrow();
});
test("cancellation discards late results and unavailable builds cannot authenticate", async () => {
  let resolve!: (value: unknown) => void;
  const native = {
    readEarnBalance: jest.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    ),
    lock: jest.fn(),
  };
  const service = createEarnPrivateBalanceService(() => native);
  const pending = service.read(intent);
  service.cancel();
  resolve(result);
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(native.lock).toHaveBeenCalled();
  await expect(createEarnPrivateBalanceService(() => null).read(intent)).rejects.toThrow();
});
