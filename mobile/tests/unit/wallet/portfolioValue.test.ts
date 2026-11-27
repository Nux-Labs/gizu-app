import {
  portfolioValue,
  portfolioUsdcBalance,
  portfolioPublicUsdcAtoms,
  portfolioAvailableUsdcAtoms,
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

function fundingSnapshot() {
  const owner = "0x" + "1".repeat(40);
  const tokens = [
    "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  ];
  const fundingSources = ([143, 8453, 42161] as const).map((sourceChainId, index) => ({
    sourceChainId,
    token: tokens[index]!,
    decimals: 6 as const,
    accountIndex: 1,
    owner,
    balanceAtoms: index === 2 ? "5000000" : "10000000",
    observedAtoms: index === 2 ? "5000000" : "10000000",
    reservedAtoms: "0",
    availableAtoms: index === 2 ? "5000000" : "10000000",
    complete: true,
    stale: false,
    syncPending: false,
    checkedAt,
  }));
  return {
    planningFundingChainIds: [143, 8453, 42161] as
      import("@/domain/wallet/storedSigner").FundingChainId[] | null,
    ...snapshot(),
    totalAtoms: "10000000",
    fundingSources,
    fundingCash: {
      observedAtoms: "25000000",
      availableAtoms: "25000000",
      complete: true,
      stale: false,
      syncPending: false,
    },
    ownedAssets: [
      asset({
        chainId: 143,
        token: "confidential:monad-usdc",
        balanceAtoms: "2000000",
        observedAtoms: "2000000",
        valueUsdcAtoms: "2000000",
      }),
      {
        ...asset({
          chainId: 8453,
          token: tokens[1],
          balanceAtoms: "13000000",
          observedAtoms: "13000000",
          valueUsdcAtoms: "13000000",
        }),
        fundingIncludedAtoms: "10000000",
      },
    ],
  };
}

test("funding cash combines three origins and private USDC once while retaining another owner", () => {
  const value = fundingSnapshot();
  expect(portfolioUsdcBalance(value)).toEqual({
    publicAtoms: "25000000",
    privateAtoms: "2000000",
    totalAtoms: "27000000",
  });
  expect(portfolioPublicUsdcAtoms(value)).toBe("25000000");
  expect(portfolioAvailableUsdcAtoms(value)).toBe("27000000");
  expect(portfolioValue(value).totalAtoms).toBe("30000000");
});

test("unavailable source preserves observed cash but cannot provide a complete maximum", () => {
  const value = fundingSnapshot();
  value.fundingSources[1] = {
    ...value.fundingSources[1]!,
    balanceAtoms: null as unknown as string,
    availableAtoms: null as unknown as string,
    complete: false,
    stale: true,
    syncPending: true,
  };
  value.fundingCash = {
    observedAtoms: "25000000",
    availableAtoms: null as unknown as string,
    complete: false,
    stale: true,
    syncPending: true,
  };
  expect(portfolioUsdcBalance(value)?.totalAtoms).toBe("27000000");
  expect(portfolioPublicUsdcAtoms(value)).toBeNull();
  expect(portfolioAvailableUsdcAtoms(value)).toBeNull();
  expect(portfolioValue(value).complete).toBe(false);
});

test("disabled network observations do not enlarge Max or block enabled Monad cash", () => {
  const value = fundingSnapshot();
  value.planningFundingChainIds = [143];
  value.fundingSources[1] = {
    ...value.fundingSources[1]!,
    balanceAtoms: null as unknown as string,
    availableAtoms: null as unknown as string,
    complete: false,
    stale: true,
    syncPending: true,
  };
  value.fundingCash = {
    ...value.fundingCash,
    complete: false,
    availableAtoms: null as unknown as string,
    stale: true,
    syncPending: true,
  };
  expect(portfolioUsdcBalance(value)?.totalAtoms).toBe("27000000");
  expect(portfolioPublicUsdcAtoms(value)).toBe("10000000");
  expect(portfolioAvailableUsdcAtoms(value)).toBe("12000000");
  value.planningFundingChainIds = [];
  expect(portfolioAvailableUsdcAtoms(value)).toBe("2000000");
});

test("failed capability reads preserve observed cash without guessing enabled sources", () => {
  const value = fundingSnapshot();
  value.planningFundingChainIds = null;
  expect(portfolioUsdcBalance(value)?.totalAtoms).toBe("27000000");
  expect(portfolioAvailableUsdcAtoms(value)).toBeNull();
});

test.each([
  ["0", "9900000"],
  ["25000000", "34900000"],
])(
  "confirmed credit with a suppressed source observation and %s unrelated cash does not count pre-credit money twice",
  (unrelated, expected) => {
    const value = fundingSnapshot();
    value.fundingSources[0] = {
      ...value.fundingSources[0]!,
      balanceAtoms: null as unknown as string,
      observedAtoms: null as unknown as string,
      availableAtoms: null as unknown as string,
      complete: false,
      stale: true,
      syncPending: true,
    };
    value.fundingSources[1] = {
      ...value.fundingSources[1]!,
      balanceAtoms: unrelated,
      observedAtoms: unrelated,
      availableAtoms: unrelated,
    };
    value.fundingSources[2] = {
      ...value.fundingSources[2]!,
      balanceAtoms: "0",
      observedAtoms: "0",
      availableAtoms: "0",
    };
    value.fundingCash = {
      observedAtoms: unrelated,
      availableAtoms: null as unknown as string,
      complete: false,
      stale: true,
      syncPending: true,
    };
    value.ownedAssets = [
      asset({
        chainId: 143,
        token: "confidential:monad-usdc",
        balanceAtoms: "9900000",
        observedAtoms: "9900000",
        valueUsdcAtoms: "9900000",
      }),
    ];
    expect(portfolioUsdcBalance(value)?.totalAtoms).toBe(expected);
    expect(portfolioValue(value)).toMatchObject({ totalAtoms: expected, complete: false });
    expect(portfolioAvailableUsdcAtoms(value)).toBeNull();
  },
);

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

test("unpriced non-stablecoins and unknown balances preserve a partial sum", () => {
  const missing = asset({ token: "unknown", valueUsdcAtoms: null, valuationUnavailable: true });
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

test("the USD total retains observed private USDC and USDG when reads or prices expire", () => {
  const native = {
    ...snapshot(),
    totalAtoms: "90000",
    ownedAssets: [
      asset({ balanceAtoms: "150000", observedAtoms: "150000", valueUsdcAtoms: null }),
      asset({
        chainId: 143,
        token: "confidential:monad-usdc",
        balanceAtoms: null,
        observedAtoms: "2430000",
        complete: false,
        stale: true,
        valueUsdcAtoms: null,
      }),
      asset({
        chainId: 1,
        token: earnProfiles["ethereum-usdc"].token,
        balanceAtoms: "10000",
        observedAtoms: "10000",
        valueUsdcAtoms: null,
      }),
    ],
  };
  expect(portfolioValue(native)).toMatchObject({ totalAtoms: "2680000", complete: false });
  expect(native.totalAtoms).toBe("90000");
});

test.each([
  ["unknown contract", { token: "0x" + "f".repeat(40), symbol: "USDC" }],
  ["wrong precision", { decimals: 18 }],
  ["missing observation", { balanceAtoms: null, complete: false, checkedAt: 0 }],
] as const)("stablecoin fallback excludes a %s", (_, overrides) => {
  expect(
    portfolioValue({
      ...snapshot(),
      ownedAssets: [asset({ ...overrides, valueUsdcAtoms: null })],
    }).totalAtoms,
  ).toBe("1000000");
});

test("cached stablecoin vault values use underlying units rather than share units", () => {
  expect(
    portfolioValue({
      ...snapshot(),
      positions: [
        position({
          complete: false,
          stale: true,
          balanceAtoms: null,
          underlyingAtoms: null,
          observedAtoms: "9999999999999999999",
          observedUnderlyingAtoms: "150000",
          valueUsdcAtoms: null,
        }),
      ],
    }).totalAtoms,
  ).toBe("1150000");
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

test("deposit USDC observations reuse public and private cash without including USDG or vault value", () => {
  const cash = asset({
    assetId: "private",
    chainId: 143,
    token: "confidential:monad-usdc",
    balanceAtoms: null,
    observedAtoms: "2430000",
    complete: false,
    stale: true,
    valueUsdcAtoms: null,
  });
  const observed = {
    ...snapshot(),
    fundingAtoms: "90000",
    totalAtoms: "90000",
    ownedAssets: [cash, { ...cash, assetId: "alias" }, asset()],
    positions: [position()],
  };
  expect(portfolioUsdcBalance(observed)).toEqual({
    publicAtoms: "90000",
    privateAtoms: "2430000",
    totalAtoms: "2520000",
  });
  expect(portfolioPublicUsdcAtoms(observed)).toBe("90000");
  expect(
    portfolioUsdcBalance({ ...snapshot(), balanceComplete: false, totalAtoms: "0" }),
  ).toBeNull();
});
