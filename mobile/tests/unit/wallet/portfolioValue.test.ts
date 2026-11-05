import {
  portfolioValue,
  portfolioVaultPosition,
  vaultPositionProfile,
} from "@/domain/wallet/portfolioValue";
import { earnProfiles } from "@/domain/earn/types";
import type { OwnedPortfolioAsset, OwnedPortfolioPosition } from "@/domain/wallet/storedSigner";
import { mainnetPortfolio } from "../../support/mainnetWallet";

const checkedAt = 1000000;
function asset(overrides: Partial<OwnedPortfolioAsset> = {}): OwnedPortfolioAsset {
  return {
    assetId: "hood-usdg",
    chainId: 4663,
    token: earnProfiles["robinhood-usdg"].token,
    symbol: "USDG",
    decimals: 6,
    balanceAtoms: "2000000",
    observedAtoms: "2000000",
    complete: true,
    stale: false,
    checkedAt,
    valueUsdcAtoms: "1800000",
    valuationUnavailable: false,
    ...overrides,
  };
}
function position(overrides: Partial<OwnedPortfolioPosition> = {}): OwnedPortfolioPosition {
  return {
    ...asset({ token: earnProfiles["robinhood-usdg"].vault }),
    shareAtoms: "1230000000000000000",
    underlyingAtoms: "3000000",
    valueUsdcAtoms: "2700000",
    conversionEstimated: true,
    ...overrides,
  };
}
function snapshot() {
  return { ...mainnetPortfolio("wallet", "0x" + "1".repeat(40), "1000000"), checkedAt };
}

test("display total adds owned tokens and vault underlying without changing spendable total", () => {
  const native = { ...snapshot(), ownedAssets: [asset()], positions: [position()] };
  expect(portfolioValue(native)).toEqual({
    totalAtoms: "5500000",
    liquidAtoms: "1000000",
    assetsAtoms: "1800000",
    vaultAtoms: "2700000",
    complete: true,
    estimated: true,
    checkedAt,
  });
  expect(native.totalAtoms).toBe("1000000");
});

test("deduplicates canonical contracts across aliases and keeps confidential USDC distinct", () => {
  const usd = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
  const native = {
    ...snapshot(),
    ownedAssets: [
      asset(),
      asset({ assetId: "alias", token: earnProfiles["robinhood-usdg"].token.toUpperCase() }),
      asset({ chainId: 143, token: usd, valueUsdcAtoms: "1000000" }),
      asset({ chainId: 143, token: "confidential:monad-usdc", valueUsdcAtoms: "4000000" }),
    ],
    positions: [position(), position({ assetId: "alias-vault" })],
  };
  expect(portfolioValue(native).totalAtoms).toBe("9500000");
});

test("unpriced nonzero and unknown balances preserve a partial sum", () => {
  const missing = asset({ valueUsdcAtoms: null, valuationUnavailable: true });
  expect(portfolioValue({ ...snapshot(), ownedAssets: [missing] })).toMatchObject({
    totalAtoms: "1000000",
    complete: false,
  });
  expect(
    portfolioValue({
      ...snapshot(),
      ownedAssets: [asset({ balanceAtoms: null, observedAtoms: "0", complete: false })],
    }).complete,
  ).toBe(false);
});

test("known zero unpriced assets do not make the valuation partial", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      valuationComplete: false,
      ownedAssets: [
        asset({
          balanceAtoms: "0",
          observedAtoms: "0",
          valueUsdcAtoms: null,
          valuationUnavailable: true,
        }),
      ],
    }).complete,
  ).toBe(true);
});

test("cached and incomplete nonzero rows remain estimated and partial with their oldest time", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      ownedAssets: [asset({ stale: true, checkedAt: checkedAt - 10000 })],
    }),
  ).toMatchObject({ complete: false, estimated: true, checkedAt: 990000 });
  expect(portfolioValue({ ...snapshot(), stale: true }).complete).toBe(false);
});

test("large atomic values never lose precision", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      totalAtoms: "9007199254740993000000",
      ownedAssets: [asset({ valueUsdcAtoms: "9007199254740993000001" })],
      positions: [position({ valueUsdcAtoms: "9007199254740993000002" })],
    }).totalAtoms,
  ).toBe("27021597764222979000003");
});

test("a vault contract duplicated in token inventory contributes only its vault value", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      ownedAssets: [
        asset({ token: earnProfiles["robinhood-usdg"].vault, valueUsdcAtoms: "2700000" }),
      ],
      positions: [position()],
    }).totalAtoms,
  ).toBe("3700000");
});

test("canonical duplicates prefer the complete fresh observation", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      ownedAssets: [asset({ stale: true, valueUsdcAtoms: "1700000" }), asset()],
    }),
  ).toMatchObject({ totalAtoms: "2800000", complete: true });
});

test("vault routing binds the exact chain and pinned vault rather than token symbol", () => {
  expect(vaultPositionProfile(position({ symbol: "anything" }))).toBe("robinhood-usdg");
  expect(vaultPositionProfile(position({ chainId: 1 }))).toBeNull();
  expect(
    vaultPositionProfile(position({ token: earnProfiles["robinhood-usdg"].token })),
  ).toBeNull();
  expect(portfolioVaultPosition(null, "robinhood-usdg")).toBeNull();
  expect(portfolioVaultPosition(undefined, "ethereum-usdc")).toBeNull();
  expect(
    portfolioVaultPosition({ ...snapshot(), positions: [position()] }, "ethereum-usdc"),
  ).toBeNull();
  expect(
    portfolioVaultPosition({ ...snapshot(), positions: [position()] }, "robinhood-usdg")
      ?.underlyingAtoms,
  ).toBe("3000000");
});
