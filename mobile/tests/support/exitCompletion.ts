import { hoodIntent } from "./robinhoodEarn";
import type { SponsoredOperation } from "@/domain/earn/sourceFunding";
import { monadConfidentialUsdcAssetId } from "@/domain/earn/types";
export function minimumReturnRow(): SponsoredOperation {
  const { creditedAtoms: _credit, ...row } = returnRow();
  return {
    ...row,
    revision: 2,
    status: "minimumReceived",
    verifiedMinimumAtoms: "899000",
    minimumReturnReceipt: {
      operationId: row.operationId,
      revision: 1,
      confidentialAddress: hoodIntent.confidentialAddress,
      assetId: monadConfidentialUsdcAssetId,
      depositAddress: "0x" + "9".repeat(40),
      transactionHash: row.transactionHash!,
      verifiedMinimumAtoms: "899000",
      status: "minimumReceived",
      verification: "minimum-return-v1",
      observedAtMs: 1000000,
      timestampMs: Date.now(),
      authenticated: true,
      operationScoped: true,
      spendingAuthorized: false,
      exactAmountKnown: false,
    },
  };
}
export function returnRow(): SponsoredOperation {
  return {
    operationId: "return_1",
    revision: 1,
    walletId: hoodIntent.walletId,
    kind: "hoodTokenReturn",
    chainId: 4663,
    from: hoodIntent.destinations[1].address,
    amountAtoms: "900000",
    nonce: "0x1",
    status: "credited",
    blocked: false,
    canResume: false,
    creditedAtoms: "899000",
    transactionHash: "0x" + "a".repeat(64),
  };
}
export function exitSnapshot(now: number) {
  return {
    profileId: "robinhood-usdg",
    chainId: 4663,
    owner: hoodIntent.destinations[1].address,
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    vault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
    wrappedToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    tokenDecimals: 6,
    wrappedDecimals: 18,
    shareDecimals: 18,
    balances: { tokenAtoms: "100000", nativeWei: "0", wrappedWei: "0", shares: "0" },
    priceMaxAgeMs: 300000,
    prices: {
      tokenUsd18: "1000000000000000000",
      usdcUsd18: "1000000000000000000",
      ethUsd18: null as string | null,
      tokenPriceUpdatedAt: new Date(now).toISOString(),
      usdcPriceUpdatedAt: new Date(now).toISOString(),
      ethPriceUpdatedAt: null as string | null,
      observedAtMs: now,
    },
    reference: { blockNumber: "100", blockHash: "0x" + "b".repeat(64), blockTimestampMs: now },
    observedAtMs: now,
    expiresAtMs: now + 60000,
    residualUsdcAtoms: "100000",
    publicResidualReady: true,
    optimalResidual: false,
    readOnly: true,
    completionAttested: false,
    walletScope: "investment-only-hold-wallet-excluded",
    snapshotHash: "0x" + "c".repeat(64),
  };
}
