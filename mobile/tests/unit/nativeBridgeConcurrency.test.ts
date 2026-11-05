import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  getStoredSigner,
  getStoredSwapSigner,
  getStoredEarnDepositSigner,
  getStoredWalletRecoverySigner,
} from "@/services/wallet/nativeBridge";
jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));
const originalOS = Platform.OS;
const originalVersion = Platform.Version;
afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  Object.defineProperty(Platform, "Version", { configurable: true, value: originalVersion });
});
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
test("old native builds can resume legacy sales but cannot start a public-payout sale under the private UI", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  const native = {
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, available: true, swaps: true }),
    startSell: jest.fn(),
    sellSwapHolding: jest.fn(),
    resumeSwap: jest.fn().mockResolvedValue({ phase: "PAUSED" }),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const signer = getStoredSwapSigner()!;
  await expect(signer.startSell("https://backend.test")).rejects.toThrow();
  await expect(signer.sellSwapHolding("saved-holding", "https://backend.test")).rejects.toThrow();
  expect(native.startSell).not.toHaveBeenCalled();
  expect(native.sellSwapHolding).not.toHaveBeenCalled();
  await expect(signer.resumeSwap("https://backend.test")).resolves.toEqual({ phase: "PAUSED" });
});
test("an older native build can read saved deposits but cannot prepare a new distributed deposit", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  const native = {
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, available: true, earnDepositJourney: true }),
    prepareEarnDeposit: jest.fn(),
    resumeEarnDeposit: jest.fn(),
    confirmEarnDeposit: jest.fn(),
    getEarnDepositStatus: jest.fn().mockResolvedValue({ phase: "paused" }),
    cancelEarnDeposit: jest.fn(),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const signer = getStoredEarnDepositSigner()!;
  await expect(signer.getEarnDepositStatus("wallet", "saved")).resolves.toEqual({
    phase: "paused",
  });
  await expect(
    signer.prepareEarnDeposit("wallet", "robinhood-usdg", "3000000", null),
  ).rejects.toThrow(/updated native app/);
  expect(native.prepareEarnDeposit).not.toHaveBeenCalled();
});
test("recovery snapshots stay readable during discovery and pause interrupts its native lane", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const native = {
    getCapabilities: jest.fn().mockResolvedValue({
      contractVersion: 1,
      available: true,
      walletRecovery: true,
      walletDiscovery: true,
    }),
    discoverWallets: jest.fn(() => pending),
    getWalletRecoveryStatus: jest.fn().mockResolvedValue({ phase: "discovering" }),
    syncWalletRecovery: jest.fn(),
    cancelWalletDiscovery: jest.fn().mockResolvedValue({ phase: "paused" }),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const signer = getStoredWalletRecoverySigner()!;
  const discovery = signer.discoverWallets("wallet", 256);
  const interrupted = expect(discovery).rejects.toThrow(/cancelled/);
  await tick();
  try {
    await Promise.all([
      signer.getWalletRecoveryStatus("wallet"),
      signer.getWalletRecoveryStatus("wallet"),
    ]);
    expect(native.getWalletRecoveryStatus).toHaveBeenCalledTimes(1);
    const sync = signer.syncWalletRecovery("wallet");
    const dropped = expect(sync).rejects.toThrow(/cancelled/);
    await tick();
    await expect(signer.cancelWalletDiscovery("wallet")).resolves.toEqual({ phase: "paused" });
    await dropped;
    expect(native.syncWalletRecovery).not.toHaveBeenCalled();
  } finally {
    finish({ phase: "paused" });
    await interrupted;
  }
});
test("older native capabilities cannot execute the new recovery APIs", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  const native = {
    getCapabilities: jest.fn().mockResolvedValue({ contractVersion: 1, available: true }),
    syncWalletRecovery: jest.fn(),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  await expect(getStoredWalletRecoverySigner()!.syncWalletRecovery("wallet")).rejects.toThrow(
    /unavailable/,
  );
  expect(native.syncWalletRecovery).not.toHaveBeenCalled();
});
test("deposit progress reads run during preparation while other mutations stay serialized", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const native = {
    getCapabilities: jest.fn().mockResolvedValue({
      contractVersion: 1,
      available: true,
      earnDepositJourney: true,
      earnDepositDistribution: true,
    }),
    prepareEarnDeposit: jest.fn(() => pending),
    resumeEarnDeposit: jest.fn(),
    confirmEarnDeposit: jest.fn().mockResolvedValue({ phase: "funding" }),
    getEarnDepositStatus: jest.fn().mockResolvedValue({ phase: "preparing" }),
    cancelEarnDeposit: jest.fn(),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const signer = getStoredEarnDepositSigner()!;
  const preparation = signer.prepareEarnDeposit("wallet", "robinhood-usdg", "3000000", null);
  await tick();
  const status = signer.getEarnDepositStatus("wallet", "journey");
  const nextMutation = signer.confirmEarnDeposit("wallet", "journey", 2);
  try {
    await tick();
    expect(native.getEarnDepositStatus).toHaveBeenCalledTimes(1);
    expect(native.confirmEarnDeposit).not.toHaveBeenCalled();
  } finally {
    finish({ phase: "review" });
    await Promise.all([preparation, status, nextMutation]);
  }
});
test("deposit status coalesces and journey cancellation interrupts a pending confirmation", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 35 });
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const native = {
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, available: true, earnDepositJourney: true }),
    prepareEarnDeposit: jest.fn(),
    resumeEarnDeposit: jest.fn(),
    confirmEarnDeposit: jest.fn(() => pending),
    getEarnDepositStatus: jest.fn().mockResolvedValue({ phase: "funding" }),
    cancelEarnDeposit: jest.fn().mockResolvedValue({ phase: "paused", pauseReason: "cancelled" }),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const a = getStoredEarnDepositSigner()!,
    b = getStoredEarnDepositSigner()!;
  await Promise.all([
    a.getEarnDepositStatus("wallet", "journey"),
    b.getEarnDepositStatus("wallet", "journey"),
  ]);
  expect(native.getEarnDepositStatus).toHaveBeenCalledTimes(1);
  const confirm = a.confirmEarnDeposit("wallet", "journey", 2);
  const rejected = expect(confirm).rejects.toThrow(/cancelled/);
  await tick();
  await expect(b.cancelEarnDeposit("wallet", "journey", 2)).resolves.toEqual({
    phase: "paused",
    pauseReason: "cancelled",
  });
  expect(native.cancelEarnDeposit).toHaveBeenCalledTimes(1);
  finish({ phase: "funding" });
  await rejected;
});
test.each(["android", "ios"])("%s coordinates calls across separate adapters", async (os) => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
  Object.defineProperty(Platform, "Version", { configurable: true, value: 30 });
  let finish!: (value: unknown) => void;
  const observation = new Promise((resolve) => {
    finish = resolve;
  });
  const native = {
    getCapabilities: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, available: true, walletStorage: true, swaps: true }),
    getMainnetPortfolio: jest.fn(() => observation),
    getSwapStatus: jest.fn().mockResolvedValue({ phase: "NONE" }),
    startSwap: jest.fn().mockResolvedValue({ phase: "PAUSED" }),
    lock: jest.fn(),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  const a = getStoredSwapSigner()!;
  const b = getStoredSwapSigner()!;
  const first = a.getMainnetPortfolio();
  const duplicate = b.getMainnetPortfolio();
  await tick();
  expect(native.getMainnetPortfolio).toHaveBeenCalledTimes(1);
  const status = b.getSwapStatus("gateway");
  const start = a.startSwap("target", "4000000", "gateway");
  await tick();
  expect(native.startSwap).not.toHaveBeenCalled();
  finish({ totalAtoms: "4" });
  await Promise.all([first, duplicate, status, start]);
  expect(native.startSwap).toHaveBeenCalledTimes(1);
  expect(native.startSwap.mock.invocationCallOrder[0]).toBeLessThan(
    native.getSwapStatus.mock.invocationCallOrder[0]!,
  );
  getStoredSigner()!.lock();
  expect(native.lock).toHaveBeenCalledTimes(1);
});
