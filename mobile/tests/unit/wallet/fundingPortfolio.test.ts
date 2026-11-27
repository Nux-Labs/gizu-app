import { validateMainnetPortfolio } from "@/features/wallet/MainnetWalletProvider";
import { mainnetPortfolio } from "../../support/mainnetWallet";

const owner = "0x" + "1".repeat(40);
function snapshot() {
  return {
    ...mainnetPortfolio("wallet", owner, "10000000"),
    fundingSources: ([143, 8453, 42161] as const).map((sourceChainId, i) => ({
      sourceChainId,
      token: [
        "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      ][i]!,
      decimals: 6 as const,
      accountIndex: 1,
      owner,
      balanceAtoms: "10000000",
      observedAtoms: "10000000",
      reservedAtoms: "0",
      availableAtoms: "10000000",
      complete: true,
      stale: false,
      syncPending: false,
      checkedAt: 123,
    })),
    fundingCash: {
      observedAtoms: "30000000",
      availableAtoms: "30000000",
      complete: true,
      stale: false,
      syncPending: false,
    },
  };
}
test("accepts the same Account 1 on three distinct native USDC networks", () => {
  const value = snapshot();
  expect(validateMainnetPortfolio(value, "wallet")).toBe(value);
});
test.each(["duplicate", "token", "precision", "owner", "unavailable", "total"])(
  "rejects a changed %s funding observation",
  (change) => {
    const value = snapshot();
    if (change === "duplicate") value.fundingSources.push(value.fundingSources[1]!);
    if (change === "token") value.fundingSources[1]!.token = "0x" + "f".repeat(40);
    if (change === "precision") value.fundingSources[1]!.decimals = 18 as 6;
    if (change === "owner") value.fundingSources[1]!.owner = "0x" + "2".repeat(40);
    if (change === "unavailable") value.fundingSources[1]!.stale = true;
    if (change === "total") value.fundingCash.observedAtoms = "40000000";
    expect(() => validateMainnetPortfolio(value, "wallet")).toThrow();
  },
);
