import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  getSignerCapabilities,
  getStoredStrategySigner,
  WalletUnavailableError,
} from "@/services/wallet/nativeBridge";

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));

const originalOS = Platform.OS;
const originalVersion = Platform.Version;
afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  Object.defineProperty(Platform, "Version", { configurable: true, value: originalVersion });
});
function platform(os: "android" | "ios", version: number) {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
  Object.defineProperty(Platform, "Version", { configurable: true, value: version });
}

const word = (digit: string) => `0x${digit.repeat(64)}`;
const signer = "0x1cED07C44A78772081bc6490A05584dD4bfF15B5";
const signature = `0x${"ab".repeat(64)}1b`;
const assets = [
  {
    chainId: 8453,
    kind: 0 as const,
    address: "0xb20000000000000000000078ee7ce2fE4908108C",
    weightBps: 6000,
  },
  {
    chainId: 8453,
    kind: 0 as const,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weightBps: 4000,
  },
];

function strategyNative(overrides: Record<string, unknown> = {}) {
  return {
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, available: true, strategySigning: true }),
    strategyAddresses: jest.fn().mockResolvedValue([signer]),
    createStrategy: jest.fn().mockResolvedValue({ signer, signature }),
    sealStrategyCommit: jest.fn().mockResolvedValue({
      signer,
      assetIds: [word("1"), word("2")],
      weightsBps: [6000, 4000],
      commitment: word("c"),
      signature,
      salt: word("5"),
    }),
    ...overrides,
  };
}

test("strategy signing is advertised only on Android builds that expose every native method", async () => {
  platform("android", 35);
  jest.mocked(requireOptionalNativeModule).mockReturnValue(strategyNative());
  expect((await getSignerCapabilities()).strategySigning).toBe(true);

  const old = strategyNative({ sealStrategyCommit: undefined });
  jest.mocked(requireOptionalNativeModule).mockReturnValue(old);
  expect((await getSignerCapabilities()).strategySigning).toBe(false);
  expect(getStoredStrategySigner()).toBeNull();

  platform("ios", 18);
  jest.mocked(requireOptionalNativeModule).mockReturnValue(strategyNative());
  expect((await getSignerCapabilities()).strategySigning).toBe(false);
});

test("passes public basket data to native code and returns the validated sealed commit", async () => {
  platform("android", 35);
  const native = strategyNative();
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const strategies = getStoredStrategySigner()!;

  await expect(strategies.strategyAddresses("wallet-1", 84532, 0, 1)).resolves.toEqual([signer]);
  expect(native.strategyAddresses).toHaveBeenCalledWith("wallet-1", 84532, 0, 1);

  await expect(
    strategies.createStrategy("wallet-1", 84532, 0, 604800, word("d"), 1_900_000_600),
  ).resolves.toEqual({ signer, signature });
  expect(native.createStrategy).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    604800,
    word("d"),
    1_900_000_600,
  );

  const sealed = await strategies.sealStrategyCommit(
    "wallet-1",
    84532,
    0,
    1,
    0,
    assets,
    1_900_000_600,
  );
  expect(sealed).toMatchObject({
    commitment: word("c"),
    weightsBps: [6000, 4000],
    salt: word("5"),
  });
  expect(native.sealStrategyCommit).toHaveBeenCalledWith(
    "wallet-1",
    84532,
    0,
    1,
    0,
    assets,
    1_900_000_600,
  );
});

test("rejects invalid requests before native code and malformed native results after it", async () => {
  platform("android", 35);
  const native = strategyNative({
    sealStrategyCommit: jest.fn().mockResolvedValue({
      signer,
      assetIds: [word("1")],
      weightsBps: [10000],
      commitment: word("c"),
      signature,
      salt: word("5"),
    }),
    createStrategy: jest.fn().mockResolvedValue({ signer, signature: "0x1234" }),
  });
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const strategies = getStoredStrategySigner()!;

  await expect(
    strategies.createStrategy("wallet-1", 84532, 0, 60, "0xnot-a-hash", 1_900_000_600),
  ).rejects.toThrow("Invalid strategy metadata hash.");
  await expect(strategies.strategyAddresses("wallet-1", 84532, 0, 33)).rejects.toThrow(
    "Invalid strategy address range.",
  );
  await expect(
    strategies.sealStrategyCommit("wallet-1", 84532, 0, 1, 0, [], 1_900_000_600),
  ).rejects.toThrow("A strategy holds one to ten assets.");
  expect(native.createStrategy).not.toHaveBeenCalled();
  expect(native.strategyAddresses).not.toHaveBeenCalled();

  await expect(
    strategies.createStrategy("wallet-1", 84532, 0, 60, word("d"), 1_900_000_600),
  ).rejects.toThrow("Invalid native strategy response.");
  // Native returned one sealed asset for a two-asset request.
  await expect(
    strategies.sealStrategyCommit("wallet-1", 84532, 0, 1, 0, assets, 1_900_000_600),
  ).rejects.toThrow("Invalid native strategy response.");
});

test("refuses to sign when the native build no longer reports the capability", async () => {
  platform("android", 35);
  const native = strategyNative({
    getCapabilities: jest.fn().mockResolvedValue({ contractVersion: 1, available: true }),
  });
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  await expect(
    getStoredStrategySigner()!.createStrategy("wallet-1", 84532, 0, 60, word("d"), 1_900_000_600),
  ).rejects.toBeInstanceOf(WalletUnavailableError);
  expect(native.createStrategy).not.toHaveBeenCalled();
});
