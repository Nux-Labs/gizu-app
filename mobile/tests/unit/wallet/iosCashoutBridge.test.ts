import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  getSignerCapabilities,
  getStoredConfidentialWithdrawalSigner,
} from "@/services/wallet/nativeBridge";

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));
const originalOS = Platform.OS;
const originalVersion = Platform.Version;
afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  Object.defineProperty(Platform, "Version", { configurable: true, value: originalVersion });
});
function moduleForIos(enabled: boolean) {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  Object.defineProperty(Platform, "Version", { configurable: true, value: "18.0" });
  const native = {
    getCapabilities: jest.fn().mockResolvedValue({
      contractVersion: 1,
      available: true,
      confidentialWithdrawals: enabled,
    }),
    getConfidentialWithdrawal: jest.fn().mockResolvedValue(null),
    prepareConfidentialWithdrawal: jest.fn().mockResolvedValue({ status: "review" }),
    executeConfidentialWithdrawal: jest.fn().mockResolvedValue({ status: "pending" }),
    resumeConfidentialWithdrawal: jest.fn().mockResolvedValue({ status: "paid" }),
    cancelConfidentialWithdrawal: jest.fn().mockResolvedValue({ status: "cancelled" }),
  };
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  return native;
}
test("iOS exposes cashout only when the native build advertises it", async () => {
  const native = moduleForIos(false);
  expect((await getSignerCapabilities()).confidentialWithdrawals).toBe(false);
  await expect(
    getStoredConfidentialWithdrawalSigner()!.prepareConfidentialWithdrawal({
      walletId: "wallet",
      amountAtoms: "1000000",
    }),
  ).rejects.toThrow();
  expect(native.prepareConfidentialWithdrawal).not.toHaveBeenCalled();
});
test("iOS delegates all cashout actions without exposing native signing details", async () => {
  const native = moduleForIos(true);
  expect((await getSignerCapabilities()).confidentialWithdrawals).toBe(true);
  const signer = getStoredConfidentialWithdrawalSigner()!;
  const operation = { walletId: "wallet", operationId: "cashout_1" };
  await signer.getConfidentialWithdrawal("wallet");
  await signer.prepareConfidentialWithdrawal({ walletId: "wallet", amountAtoms: "1000000" });
  await signer.executeConfidentialWithdrawal({ ...operation, revision: 2 });
  await signer.resumeConfidentialWithdrawal(operation);
  await signer.cancelConfidentialWithdrawal(operation);
  expect(native.getConfidentialWithdrawal).toHaveBeenCalledWith("wallet");
  expect(native.prepareConfidentialWithdrawal).toHaveBeenCalledWith({
    walletId: "wallet",
    amountAtoms: "1000000",
  });
  expect(native.executeConfidentialWithdrawal).toHaveBeenCalledWith({ ...operation, revision: 2 });
  expect(native.resumeConfidentialWithdrawal).toHaveBeenCalledWith(operation);
  expect(native.cancelConfidentialWithdrawal).toHaveBeenCalledWith(operation);
});
