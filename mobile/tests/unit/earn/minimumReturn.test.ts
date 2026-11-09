import { parseSponsoredOperations } from "@/domain/earn/sourceFunding";
import { parseLiquidityOperations } from "@/domain/earn/ethereumLiquidity";
import { assertReturnCredits } from "@/domain/earn/exitCompletion";
import { payoutRequest, parsePayoutOperations } from "@/domain/earn/privatePayout";
import { monadConfidentialUsdcAssetId, type EarnIntent } from "@/domain/earn/types";
import { hoodIntent } from "../../support/robinhoodEarn";
import { returnRow } from "../../support/exitCompletion";

const receipt = () => ({
  operationId: "return_1",
  revision: 1,
  confidentialAddress: hoodIntent.confidentialAddress,
  assetId: monadConfidentialUsdcAssetId,
  depositAddress: "0x" + "9".repeat(40),
  transactionHash: returnRow().transactionHash,
  verifiedMinimumAtoms: "899000",
  status: "minimumReceived",
  verification: "minimum-return-v1",
  observedAtMs: 1000000,
  timestampMs: 2000000,
  authenticated: true,
  operationScoped: true,
  spendingAuthorized: false,
  exactAmountKnown: false,
});
function minimum() {
  const { creditedAtoms: _credit, ...row } = returnRow();
  return {
    ...row,
    revision: 2,
    status: "minimumReceived",
    verifiedMinimumAtoms: "899000",
    minimumReturnReceipt: receipt(),
  };
}
const ethereum: EarnIntent = {
  ...hoodIntent,
  profileId: "ethereum-usdc",
  destinations: hoodIntent.destinations.map((d) => ({
    ...d,
    chainId: 1 as const,
  })) as EarnIntent["destinations"],
};

test("native minimum returns preserve historical observation without becoming exact credit", () => {
  const row = parseSponsoredOperations([minimum()], hoodIntent)[0]!;
  expect(row).toMatchObject({
    status: "minimumReceived",
    verifiedMinimumAtoms: "899000",
    minimumReturnReceipt: receipt(),
  });
  expect(row).not.toHaveProperty("creditedAtoms");
  expect(assertReturnCredits([row], hoodIntent)).toEqual(["return_1"]);
  expect(() => payoutRequest(hoodIntent, row, "hold")).toThrow();
  expect(() =>
    assertReturnCredits([{ ...row, minimumReturnReceipt: undefined }], hoodIntent),
  ).toThrow();
});

test.each(["returnUsdc", "returnEth"])(
  "Ethereum %s accepts the same nonspending contract",
  (kind) => {
    const row = parseLiquidityOperations([{ ...minimum(), kind, chainId: 1 }], ethereum)[0]!;
    expect(row).toMatchObject({ kind, status: "minimumReceived", verifiedMinimumAtoms: "899000" });
    expect(assertReturnCredits([row], ethereum)).toEqual(["return_1"]);
    expect(row).not.toHaveProperty("creditedAtoms");
  },
);

test("minimum evidence rejects wrong operation, identity, amount, flags and mixed exact credit", () => {
  for (const change of [
    { operationId: "other" },
    { revision: 2 },
    { confidentialAddress: hoodIntent.sourceAddress },
    { assetId: "wrong" },
    { depositAddress: "0x" + "0".repeat(40) },
    { transactionHash: "0x" + "f".repeat(64) },
    { verifiedMinimumAtoms: "899001" },
    { verifiedMinimumAtoms: "0" },
    { authenticated: false },
    { operationScoped: false },
    { spendingAuthorized: true },
    { exactAmountKnown: true },
    { verification: "balance-delta-v1" },
    { status: "credited" },
    { observedAtMs: -1 },
    { timestampMs: 1 },
    { creditedAtoms: "899000" },
  ])
    expect(() =>
      parseSponsoredOperations(
        [{ ...minimum(), minimumReturnReceipt: { ...receipt(), ...change } }],
        hoodIntent,
      ),
    ).toThrow();
  for (const change of [
    { kind: "sourceFunding", chainId: 143, from: hoodIntent.sourceAddress },
    { kind: "hoodDeposit" },
    { kind: "hoodRedeemAll" },
    { status: "credited", creditedAtoms: "899000" },
    { creditedAtoms: "899000" },
    { settlement: {} },
    { minimumReturnEnvelope: "SECRET" },
    { verifiedMinimumAtoms: "899001" },
    { minimumReturnReceipt: undefined },
  ])
    expect(() => parseSponsoredOperations([{ ...minimum(), ...change }], hoodIntent)).toThrow();
  for (const kind of ["fusionEthOrder", "fusionUsdcApproval"])
    expect(() =>
      parseLiquidityOperations([{ ...minimum(), kind, chainId: 1 }], ethereum),
    ).toThrow();
  expect(() =>
    parsePayoutOperations([{ ...minimum(), kind: "confidentialPayout" }], hoodIntent),
  ).toThrow();
});

test("legacy exact return remains supported without a minimum receipt", () => {
  const row = parseSponsoredOperations([returnRow()], hoodIntent)[0]!;
  expect(row.creditedAtoms).toBe("899000");
  expect(assertReturnCredits([row], hoodIntent)).toEqual(["return_1"]);
  const exact = {
    ...returnRow(),
    kind: "returnUsdc",
    chainId: 1,
    settlement: {
      operationId: "return_1",
      authenticated: true,
      operationScoped: true,
      assetId: monadConfidentialUsdcAssetId,
      confidentialAddress: ethereum.confidentialAddress,
      status: "credited",
      creditedAtoms: "899000",
    },
  };
  expect(parseLiquidityOperations([exact], ethereum)[0]!.creditedAtoms).toBe("899000");
});
