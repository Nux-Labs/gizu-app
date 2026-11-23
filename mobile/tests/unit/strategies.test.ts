import {
  BASE_USDC,
  basketAssets,
  basketProblem,
  canonicalStrategyMetadata,
  metadataProblem,
  strategyMetadataHash,
  portfolioBasket,
  portfolioHoldings,
  suggestedWeights,
  usdcAtoms,
  type BasketLine,
} from "@/domain/strategies";
import type { MainnetPortfolioSnapshot, OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { strategyStockTargets } from "@/domain/strategyUniverse";

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

const vaultPosition = (value: string) => ({
  ...asset({
    chainId: 4663,
    token: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
    symbol: "vault",
    decimals: 18,
    valueUsdAtoms: value,
  }),
  shareAtoms: "1",
  underlyingAtoms: value,
});
const portfolio = (
  ownedAssets: OwnedPortfolioAsset[],
  extra: Partial<MainnetPortfolioSnapshot> = {},
): MainnetPortfolioSnapshot =>
  ({
    totalAtoms: "0",
    balanceComplete: true,
    checkedAt: 1,
    ownedAssets,
    positions: [],
    ...extra,
  }) as unknown as MainnetPortfolioSnapshot;

test("holdings are supported stocks, vaults and one USDC cash line from every stablecoin", () => {
  const snapshot = portfolio(
    [
      asset({}),
      asset({
        chainId: 4663,
        token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        symbol: "USDG",
        decimals: 6,
        valueUsdAtoms: "9000000",
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
      // Sold to zero: no longer held, so neither a line nor a blocker.
      asset({ token: "0x000000000000000000000000000000000000dEaD", balanceAtoms: "0" }),
    ],
    { totalAtoms: "1000000", positions: [vaultPosition("3000000")] } as never,
  );
  const holdings = portfolioHoldings(snapshot);
  // Cash is Monad USDC (1 public + 2 private) plus the 9 USDG held on Robinhood Chain.
  expect(holdings.lines.map((l) => [l.label, l.kind, l.valueAtoms])).toEqual([
    ["USDC", 0, 12000000n],
    ["NVDAc", 0, 4000000n],
    ["Steakhouse USDG", 1, 3000000n],
  ]);
  expect(holdings.lines[0]!.address).toBe(BASE_USDC);
  expect(holdings).toMatchObject({ unsupported: [], unpriced: [], incomplete: false });

  const basket = portfolioBasket(snapshot);
  expect(basket.weights).toEqual([6500, 2000, 1500]);
  expect(basket.blocked).toBeNull();
  expect(basket.leftOut).toEqual({ labels: [], bps: 0 });
  expect(suggestedWeights(holdings.lines)).toEqual(basket.weights);
});

test("a held stock without a market price blocks the basket instead of vanishing", () => {
  const basket = portfolioBasket(
    portfolio([
      asset({}),
      asset({
        token: "0xb2000000000000000000002D0BA3164cc74f58B7",
        symbol: "Token 4f58b7",
        valueUsdAtoms: null,
      }),
    ]),
  );
  expect(basket.blocked).toEqual({ reason: "unpriced", labels: ["Token 4f58b7"] });
});

test("unsupported stocks block once they could move a 5% weight, and are named when smaller", () => {
  const other = (value: string) =>
    asset({
      token: "0x000000000000000000000000000000000000bEEF",
      symbol: "OTHERc",
      valueUsdAtoms: value,
    });
  // 2 of 102: under half a step, so the basket can stand for the portfolio.
  const small = portfolioBasket(
    portfolio([asset({ valueUsdAtoms: "100000000" }), other("2000000")]),
  );
  expect(small.blocked).toBeNull();
  expect(small.lines.map((l) => l.label)).toEqual(["NVDAc"]);
  expect(small.leftOut).toEqual({ labels: ["OTHERc"], bps: 196 });
  // 3 of 100: half a step or more would change the weights it leaves out.
  const large = portfolioBasket(
    portfolio([asset({ valueUsdAtoms: "97000000" }), other("3000000")]),
  );
  expect(large.blocked).toEqual({ reason: "unsupported", labels: ["OTHERc"] });
});

test("an unfinished balance read blocks the basket", () => {
  expect(portfolioBasket(portfolio([asset({})], { balanceComplete: false })).blocked).toEqual({
    reason: "incomplete",
  });
  expect(portfolioBasket(portfolio([asset({ complete: false })])).blocked).toEqual({
    reason: "incomplete",
  });
});

test("past ten assets the largest keep the weights and the rest are named with their share", () => {
  const stocks = strategyStockTargets[8453].slice(0, 12).map((target, i) =>
    asset({
      token: target.address,
      symbol: target.symbol,
      // 12 down to 1 dollars, so the order is known.
      valueUsdAtoms: String((12 - i) * 1_000_000),
    }),
  );
  const basket = portfolioBasket(portfolio(stocks));
  expect(basket.lines).toHaveLength(10);
  expect(basket.weights.reduce((sum, w) => sum + w, 0)).toBe(10_000);
  expect(basket.weights.every((w) => w > 0 && w % 500 === 0)).toBe(true);
  // The two smallest are 2 + 1 of 78 dollars.
  expect(basket.leftOut.labels).toEqual(stocks.slice(10).map((s) => universeLabel(s.token)));
  expect(basket.leftOut.bps).toBe(384);
  expect(basket.blocked).toBeNull();
});

const universeLabel = (token: string) =>
  strategyStockTargets[8453].find((t) => t.address === token)!.symbol;
