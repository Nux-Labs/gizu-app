import { holdingsChanged, type SealedAssetView, type StrategyCard } from "@/domain/strategies";
import {
  agoText,
  basketChanges,
  changeText,
  isNewStrategy,
  isRanked,
  pendingReveal,
  returnSeries,
  updateCadenceDays,
} from "@/domain/strategyProfile";
import { historyEntry, quietCard } from "../support/strategies";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const NOW = Date.parse("2026-11-23T12:00:00Z");
const asset = (
  address: string,
  weightBps: number,
  chainId = 8453,
  kind: 0 | 1 = 0,
): SealedAssetView => ({
  chainId,
  kind,
  address,
  weightBps,
  assetId: `0x${address.slice(2, 4).repeat(32)}`,
});

const card = (overrides: Partial<StrategyCard> = {}): StrategyCard => ({
  id: 1,
  signer: "0x00000000000000000000000000000000000000aa",
  name: "AI chips",
  embargoSeconds: 86_400,
  monthlyPriceAtoms: "10000000",
  signalPriceAtoms: "500000",
  seats: 20,
  seatsTaken: 0,
  commits: 4,
  revealed: 3,
  broken: false,
  lastCommitAt: "2026-11-23T06:00:00Z",
  performance: { cumulativeReturnBps: 500, maxDrawdownBps: null, closedPeriods: 3, complete: true },
  earnedAtoms: "0",
  createdAt: "2026-10-01T00:00:00Z",
  registry: { chainId: 84532, address: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7" },
  ...quietCard,
  ...overrides,
});

test("an update lists what it added, removed and moved, largest moves first", () => {
  const changes = basketChanges(
    [asset(NVDA, 6000), asset(VAULT, 4000, 4663, 1)],
    [asset(NVDA, 5000), asset(AAPL, 5000)],
  );
  expect(changes.map(changeText)).toEqual([
    "+AAPLc on Base 50%",
    "Steakhouse USDG vault out",
    "NVDAc on Base 60% → 50%",
  ]);
  // The first update replaced nothing, so everything in it is new.
  expect(basketChanges(null, [asset(NVDA, 10000)]).map(changeText)).toEqual([
    "+NVDAc on Base 100%",
  ]);
  expect(basketChanges([asset(NVDA, 10000)], [asset(NVDA, 10000)])).toEqual([]);
});

test("the return series compounds closed periods and skips open or unpriced ones", () => {
  const history = [
    historyEntry({ seq: 1, assets: [], revealedAt: "x", periodReturnBps: -1000 }),
    historyEntry({ seq: 0, assets: [], revealedAt: "x", periodReturnBps: 1000 }),
    historyEntry({ seq: 2, assets: [], revealedAt: "x", periodReturnBps: null }),
    historyEntry({ seq: 3, assets: [], revealedAt: null, periodReturnBps: 5000 }),
  ];
  const series = returnSeries(history);
  expect(series).toHaveLength(3);
  expect(series[1]).toBeCloseTo(110);
  expect(series[2]).toBeCloseTo(99);
});

test("cadence, reveal countdown and relative times read from public timestamps", () => {
  expect(
    updateCadenceDays([
      historyEntry({ seq: 0, assets: [], committedAt: "2026-11-01T00:00:00Z" }),
      historyEntry({ seq: 1, assets: [], committedAt: "2026-11-05T00:00:00Z" }),
      historyEntry({ seq: 2, assets: [], committedAt: "2026-11-09T00:00:00Z" }),
    ]),
  ).toBe(4);
  expect(updateCadenceDays([historyEntry({ seq: 0, assets: [] })])).toBeNull();

  // One sealed update: its reveal time is known.
  expect(pendingReveal(card(), NOW)).toEqual({ waiting: 1, inMs: 18 * 3_600_000 });
  // Two waiting: only the newest commit time is public, so no exact countdown.
  expect(pendingReveal(card({ commits: 5 }), NOW)).toEqual({ waiting: 2, inMs: null });
  expect(pendingReveal(card({ commits: 3 }), NOW)).toBeNull();

  expect(agoText("2026-11-23T11:59:30Z", NOW)).toBe("just now");
  expect(agoText("2026-11-23T09:00:00Z", NOW)).toBe("3h ago");
  expect(agoText("2026-09-01T00:00:00Z", NOW)).toBe("2026-09-01");
});

test("a strategy is new until it has a month and three reveals, and ranks only with a record", () => {
  expect(isNewStrategy(card(), NOW)).toBe(false);
  expect(isNewStrategy(card({ createdAt: "2026-11-10T00:00:00Z" }), NOW)).toBe(true);
  expect(isNewStrategy(card({ revealed: 2 }), NOW)).toBe(true);

  expect(isRanked(card(), NOW)).toBe(true);
  expect(isRanked(card({ revealed: 2 }), NOW)).toBe(false);
  expect(isRanked(card({ createdAt: "2026-11-15T00:00:00Z" }), NOW)).toBe(false);
  expect(isRanked(card({ broken: true }), NOW)).toBe(false);
});

test("holdings changed only when amounts moved beyond dust, not when prices did", () => {
  const sealed = { "8453:0:nvda": "1000000000000000000", cash: "5000000" };
  expect(holdingsChanged(sealed, { ...sealed })).toBe(false);
  // 0.2% less cash: rounding and dust, not a decision.
  expect(holdingsChanged(sealed, { ...sealed, cash: "4990000" })).toBe(false);
  expect(holdingsChanged(sealed, { ...sealed, cash: "4000000" })).toBe(true);
  expect(holdingsChanged(sealed, { cash: "5000000" })).toBe(true);
  expect(holdingsChanged(sealed, { ...sealed, "8453:0:aapl": "1" })).toBe(true);
});
