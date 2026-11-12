import { parseSponsoredOperations } from "@/domain/earn/sourceFunding";
import { parseLiquidityOperations } from "@/domain/earn/ethereumLiquidity";
import { parseVaultOperations } from "@/domain/earn/vaultExecution";
import { parseEarnWithdrawals } from "@/domain/earn/withdrawal";
import type { EarnIntent } from "@/domain/earn/types";
import { hoodIntent } from "../../support/robinhoodEarn";

const distributed: EarnIntent = {
  ...hoodIntent,
  distribution: { version: 1, weightsBps: [4300, 5700] },
  investmentSlot: 1,
  destinations: hoodIntent.destinations.map((d, slot) => ({
    ...d,
    role: "invest",
    slot,
  })) as EarnIntent["destinations"],
};
const ethereum: EarnIntent = {
  ...distributed,
  profileId: "ethereum-usdc",
  destinations: distributed.destinations.map((d) => ({
    ...d,
    chainId: 1,
  })) as EarnIntent["destinations"],
};
const base = {
  operationId: "saved_1",
  walletId: hoodIntent.walletId,
  revision: 3,
  investmentSlot: 1,
  from: hoodIntent.destinations[1].address,
  amountAtoms: "1000000",
  blocked: true,
  canResume: true,
  status: "planned",
};

test.each([
  [
    "Robinhood",
    parseSponsoredOperations,
    distributed,
    { ...base, kind: "hoodRedeemAll", chainId: 4663, nonce: "0x2" },
  ],
  [
    "Ethereum liquidity",
    parseLiquidityOperations,
    ethereum,
    { ...base, kind: "returnUsdc", chainId: 1 },
  ],
  [
    "Ethereum vault",
    parseVaultOperations,
    ethereum,
    { ...base, kind: "vaultRedeemAll", status: "pending", actualFeeWei: "0", steps: [] },
  ],
  [
    "private payout",
    parseEarnWithdrawals,
    distributed,
    {
      ...base,
      kind: "confidentialWithdrawal",
      leg: "withdrawal",
      chainId: 143,
      recipient: "0x" + "8".repeat(40),
      minimumDestinationAtoms: "900000",
      receivedAtoms: "0",
    },
  ],
] as const)(
  "%s parsed operations retain their slot for subsequent validation and reject a different slot",
  (_label, parse, intent, raw) => {
    const operation = parse([raw], intent)[0]!;
    expect(parse([operation], intent)).toEqual([operation]);
    expect(() => parse([operation], { ...intent, investmentSlot: 0 })).toThrow(
      /different investment wallet/,
    );
    expect(() => parse([{ ...raw, investmentSlot: undefined }], intent)).toThrow(
      /different investment wallet/,
    );
  },
);
