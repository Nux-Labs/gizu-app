import {
  BASE_USDC,
  basketAssets,
  basketFromPortfolio,
  basketProblem,
  canonicalStrategyMetadata,
  metadataProblem,
  strategyMetadataHash,
  suggestedWeights,
  unsupportedHoldings,
  usdcAtoms,
  type BasketLine,
} from "@/domain/strategies";
import type { MainnetPortfolioSnapshot, OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";

test("metadata hashes match the API byte for byte, including non-ASCII names", () => {
  // Values computed by backend/src/domain/strategy.ts.
  expect(
    strategyMetadataHash({
      name: "Chips",
      monthlyPriceAtoms: "10000000",
      signalPriceAtoms: "500000",
      seats: 20,
    }),
  ).toBe("0x414a817151a722dfa46f23282600437c05a1100b83b4c37519a0594525487c69");
  expect(
    strategyMetadataHash({
      name: 'Yapay zekâ çipleri — "AI"',
      monthlyPriceAtoms: "0",
      signalPriceAtoms: "250000",
      seats: 1,
    }),
  ).toBe("0x0bd7a219ed6ddd1421dfe03cc1959cd88461e80a3174bab02a4d0a80554ea754");
  expect(
    canonicalStrategyMetadata({
      seats: 2,
      signalPriceAtoms: "1",
      name: "A",
      monthlyPriceAtoms: "2",
    }),
  ).toBe('{"v":1,"name":"A","monthlyPriceAtoms":"2","signalPriceAtoms":"1","seats":2}');
});

test("validates metadata and converts dollar prices to USDC base units", () => {
  expect(usdcAtoms("10")).toBe("10000000");
  expect(usdcAtoms("0.5")).toBe("500000");
  expect(usdcAtoms("1.123456")).toBe("1123456");
  expect(usdcAtoms("1.1234567")).toBeNull();
  expect(usdcAtoms("0,5")).toBe("500000");
  expect(usdcAtoms("-1")).toBeNull();
  expect(usdcAtoms("")).toBeNull();
  const ok = {
    name: "Chips",
    monthlyPriceAtoms: "10000000",
    signalPriceAtoms: "500000",
    seats: 20,
  };
  expect(metadataProblem(ok)).toBeNull();
  expect(metadataProblem({ ...ok, name: " Chips" })).toMatch(/Name/);
  expect(metadataProblem({ ...ok, seats: 0 })).toMatch(/Seats/);
  expect(metadataProblem({ ...ok, monthlyPriceAtoms: "01" })).toMatch(/monthly/);
});

const line = (label: string, valueAtoms: bigint): BasketLine => ({
  chainId: 8453,
  kind: 0,
  address: `0x${label.padStart(40, "0")}`,
  label,
  valueAtoms,
});

test("suggested weights round to 5% steps that always total 100%", () => {
  expect(suggestedWeights([line("a", 600n), line("b", 300n), line("c", 100n)])).toEqual([
    6000, 3000, 1000,
  ]);
  const thirds = suggestedWeights([line("a", 1n), line("b", 1n), line("c", 1n)]);
  expect(thirds.reduce((s, w) => s + w, 0)).toBe(10_000);
  expect(thirds.every((w) => w % 500 === 0)).toBe(true);
  // A position too small for one 5% step drops out of the basket.
  const tiny = suggestedWeights([line("a", 990n), line("b", 10n)]);
  expect(tiny).toEqual([10000, 0]);
  expect(basketAssets([line("a", 990n), line("b", 10n)], tiny)).toHaveLength(1);
  expect(basketProblem(tiny)).toBeNull();
  expect(basketProblem([5000, 4000])).toMatch(/90%/);
  expect(basketProblem([5100, 4900])).toMatch(/5% steps/);
  expect(basketProblem([0, 0])).toMatch(/at least one/);
});

const asset = (overrides: Partial<OwnedPortfolioAsset>): OwnedPortfolioAsset => ({
  assetId: "x",
  chainId: 8453,
  token: "0xb20000000000000000000078ee7ce2fE4908108C",
  symbol: "NVDAc",
  decimals: 18,
  balanceAtoms: "1",
  observedAtoms: "1",
  complete: true,
  stale: false,
  checkedAt: 1,
  valueUsdcAtoms: null,
  valueUsdAtoms: "4000000",
  valuationUnavailable: false,
  ...overrides,
});

test("a portfolio suggests stocks, vaults and USDC cash without stablecoin or unpriced rows", () => {
  const snapshot = {
    totalAtoms: "1000000",
    balanceComplete: true,
    checkedAt: 1,
    ownedAssets: [
      asset({}),
      asset({
        chainId: 4663,
        token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        symbol: "USDG",
        decimals: 6,
        valueUsdAtoms: "9000000",
      }),
      asset({
        token: "0x000000000000000000000000000000000000dEaD",
        symbol: "UNPRICED",
        valueUsdAtoms: null,
      }),
      asset({
        chainId: 143,
        token: "confidential:monad-usdc",
        symbol: "USDC",
        decimals: 6,
        balanceAtoms: "2000000",
        observedAtoms: "2000000",
        valueUsdAtoms: null,
      }),
    ],
    positions: [
      {
        ...asset({
          chainId: 4663,
          token: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
          symbol: "vault",
          decimals: 18,
          valueUsdAtoms: "3000000",
        }),
        shareAtoms: "1",
        underlyingAtoms: "3000000",
      },
    ],
  } as unknown as MainnetPortfolioSnapshot;
  const lines = basketFromPortfolio(snapshot);
  // Cash is Monad USDC (1 public + 2 private) plus the 9 USDG held on Robinhood Chain.
  expect(lines.map((l) => [l.label, l.kind, l.valueAtoms])).toEqual([
    ["USDC", 0, 12000000n],
    ["NVDAc", 0, 4000000n],
    ["Steakhouse USDG", 1, 3000000n],
  ]);
  expect(lines[0]!.address).toBe(BASE_USDC);
  expect(suggestedWeights(lines)).toEqual([6500, 2000, 1500]);
  // The unpriced token is skipped; a priced one outside the universe is named.
  expect(unsupportedHoldings(snapshot)).toEqual([]);
  const withOther = {
    ...snapshot,
    ownedAssets: [
      ...(snapshot.ownedAssets ?? []),
      asset({ token: "0x000000000000000000000000000000000000bEEF", symbol: "OTHERc" }),
    ],
  };
  expect(unsupportedHoldings(withOther)).toEqual(["OTHERc"]);
  expect(basketFromPortfolio(withOther).map((l) => l.label)).not.toContain("OTHERc");
});
