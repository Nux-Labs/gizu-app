import { BASE_USDC, type SealedAssetView, type StrategyCard } from "@/domain/strategies";
import {
  activeFilters,
  basketMix,
  matchesFilters,
  matchesQuery,
  noFilters,
  sortStrategies,
} from "@/domain/strategyDiscovery";
import { quietCard } from "../support/strategies";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const NOW = Date.parse("2026-11-23T12:00:00Z");
const asset = (
  address: string,
  weightBps: number,
  kind: 0 | 1 = 0,
  chainId = 8453,
): SealedAssetView => ({
  chainId,
  kind,
  address,
  weightBps,
  assetId: `0x${"1".repeat(64)}`,
});

const card = (overrides: Partial<StrategyCard> = {}): StrategyCard => ({
  id: 1,
  signer: "0x00000000000000000000000000000000000000aa",
  name: "AI chips",
  embargoSeconds: 86_400,
  monthlyPriceAtoms: "10000000",
  signalPriceAtoms: "500000",
  seats: 20,
  seatsTaken: 5,
  commits: 4,
  revealed: 4,
  broken: false,
  lastCommitAt: null,
  performance: { cumulativeReturnBps: 500, maxDrawdownBps: -800, closedPeriods: 3, complete: true },
  earnedAtoms: "0",
  createdAt: "2026-07-01T00:00:00Z",
  registry: { chainId: 84532, address: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7" },
  ...quietCard,
  latestAssets: [asset(NVDA, 6000), asset(VAULT, 1000, 1, 4663), asset(BASE_USDC, 3000)],
  ...overrides,
});

test("the basket mix splits the newest reveal into stocks, vaults and cash", () => {
  expect(basketMix(card())).toEqual({ stocks: 6000, vaults: 1000, cash: 3000 });
  expect(basketMix(card({ latestAssets: [] }))).toEqual({ stocks: 0, vaults: 0, cash: 0 });
});

test("each filter keeps only cards with the data to pass it", () => {
  const passes = (filters: Partial<typeof noFilters>, c = card()) =>
    matchesFilters(c, { ...noFilters, ...filters }, NOW);
  expect(passes({})).toBe(true);
  expect(passes({ content: "stocks" })).toBe(true);
  expect(passes({ content: "cash" })).toBe(false);
  expect(passes({ content: "vaults" })).toBe(true);
  // Nothing revealed yet: what it holds is unknown, so a holdings filter leaves it out.
  expect(passes({ content: "stocks" }, card({ latestAssets: [] }))).toBe(false);

  expect(passes({ maxDrawdownBps: 1000 })).toBe(true);
  expect(
    passes(
      { maxDrawdownBps: 1000 },
      card({ performance: { ...card().performance, maxDrawdownBps: -1500 } }),
    ),
  ).toBe(false);
  expect(
    passes(
      { maxDrawdownBps: 2000 },
      card({ performance: { ...card().performance, maxDrawdownBps: null } }),
    ),
  ).toBe(false);
  expect(passes({ noLateReveal: true }, card({ broken: true }))).toBe(false);

  expect(passes({ record: "reveals" }, card({ revealed: 2 }))).toBe(false);
  expect(passes({ record: "months" })).toBe(true);
  expect(passes({ record: "months" }, card({ createdAt: "2026-10-01T00:00:00Z" }))).toBe(false);
  expect(passes({ record: "new" })).toBe(false);

  expect(passes({ maxEmbargoSeconds: 86_400 })).toBe(true);
  expect(passes({ maxEmbargoSeconds: 86_400 }, card({ embargoSeconds: 7 * 86_400 }))).toBe(false);

  expect(passes({ price: "5to20" })).toBe(true);
  expect(passes({ price: "under5" })).toBe(false);
  expect(passes({ price: "over20" }, card({ monthlyPriceAtoms: "25000000" }))).toBe(true);
  expect(passes({ seatsOpen: true }, card({ seatsTaken: 20 }))).toBe(false);
});

test("search matches names and revealed holdings; filters become removable chips", () => {
  // Surrounding spaces are ignored, so a half-typed name still matches.
  expect(matchesQuery(card(), "  ai ch ")).toBe(true);
  expect(matchesQuery(card(), "ai chips")).toBe(true);
  expect(matchesQuery(card(), "nvda")).toBe(true);
  expect(matchesQuery(card(), "steakhouse")).toBe(true);
  expect(matchesQuery(card(), "tsla")).toBe(false);

  const chips = activeFilters({
    ...noFilters,
    content: "cash",
    maxEmbargoSeconds: 604_800,
    seatsOpen: true,
  });
  expect(chips.map((chip) => chip.label)).toEqual([
    "Mostly cash",
    "Reveals within a week",
    "Seats open",
  ]);
  expect(chips[0]!.cleared.content).toBeNull();
  expect(chips[0]!.cleared.seatsOpen).toBe(true);
});

test("ranking by return keeps short records below it, and late reveals always sink", () => {
  const best = card({ id: 1, performance: { ...card().performance, cumulativeReturnBps: 900 } });
  const late = card({
    id: 2,
    broken: true,
    performance: { ...card().performance, cumulativeReturnBps: 5000 },
  });
  const young = card({ id: 3, revealed: 1, createdAt: "2026-11-20T00:00:00Z" });
  const cheap = card({ id: 4, monthlyPriceAtoms: "1000000" });
  const { ranked, unranked } = sortStrategies([young, late, cheap, best], "return", NOW);
  expect(ranked.map((c) => c.id)).toEqual([1, 4]);
  expect(unranked.map((c) => c.id)).toEqual([3, 2]);
  expect(sortStrategies([best, cheap, late], "cheapest", NOW).ranked.map((c) => c.id)).toEqual([
    4, 1, 2,
  ]);
  expect(sortStrategies([best, cheap], "trending", NOW).unranked).toEqual([]);
});
