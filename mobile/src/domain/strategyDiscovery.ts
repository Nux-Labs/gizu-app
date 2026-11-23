import { BASE_USDC, type StrategyCard } from "./strategies";
import { signalAssetInfo } from "./strategyCopy";
import { isNewStrategy, isRanked } from "./strategyProfile";

const DAY_MS = 86_400_000;

export type DiscoverSort = "return" | "trending" | "followed" | "newest" | "cheapest";

export const discoverSorts: { key: DiscoverSort; label: string; hint: string }[] = [
  { key: "return", label: "Top return", hint: "Verified return, for strategies with a record" },
  { key: "trending", label: "Trending", hint: "Most likes and comments" },
  { key: "followed", label: "Most followed", hint: "Most seats taken" },
  { key: "newest", label: "Newest", hint: "Most recently published" },
  { key: "cheapest", label: "Lowest price", hint: "Cheapest monthly price first" },
];

export type ContentFilter = "stocks" | "vaults" | "cash";
export type RecordFilter = "reveals" | "months" | "new";
export type PriceFilter = "under5" | "5to20" | "over20";

export type DiscoverFilters = {
  content: ContentFilter | null;
  /** Worst drop must stay within this many basis points. */
  maxDrawdownBps: 1000 | 2000 | null;
  noLateReveal: boolean;
  record: RecordFilter | null;
  /** Weights must be revealed within this many seconds. */
  maxEmbargoSeconds: 86_400 | 604_800 | null;
  price: PriceFilter | null;
  seatsOpen: boolean;
};

export const noFilters: DiscoverFilters = {
  content: null,
  maxDrawdownBps: null,
  noLateReveal: false,
  record: null,
  maxEmbargoSeconds: null,
  price: null,
  seatsOpen: false,
};

type Option<T> = { value: T; label: string };

/** The filter sheet's groups, in the order people ask about a strategy. */
export const filterOptions = {
  content: [
    { value: "stocks", label: "Mostly stocks" },
    { value: "vaults", label: "Uses Earn vaults" },
    { value: "cash", label: "Mostly cash" },
  ] satisfies Option<ContentFilter>[],
  maxDrawdownBps: [
    { value: 1000, label: "Worst drop under 10%" },
    { value: 2000, label: "Worst drop under 20%" },
  ] satisfies Option<1000 | 2000>[],
  record: [
    { value: "reveals", label: "3+ reveals" },
    { value: "months", label: "3+ months old" },
    { value: "new", label: "New" },
  ] satisfies Option<RecordFilter>[],
  maxEmbargoSeconds: [
    { value: 86_400, label: "Within a day" },
    { value: 604_800, label: "Within a week" },
  ] satisfies Option<86_400 | 604_800>[],
  price: [
    { value: "under5", label: "Under $5" },
    { value: "5to20", label: "$5–$20" },
    { value: "over20", label: "Over $20" },
  ] satisfies Option<PriceFilter>[],
};

/** Share of the newest revealed basket in stocks, Earn vaults and cash, in basis points. */
export function basketMix(card: StrategyCard) {
  let stocks = 0;
  let vaults = 0;
  let cash = 0;
  for (const asset of card.latestAssets) {
    if (asset.kind === 1) vaults += asset.weightBps;
    else if (asset.address.toLowerCase() === BASE_USDC.toLowerCase()) cash += asset.weightBps;
    else stocks += asset.weightBps;
  }
  return { stocks, vaults, cash };
}

const priceUsd = (card: StrategyCard) => Number(BigInt(card.monthlyPriceAtoms)) / 1e6;

/** Whether a card passes every chosen filter. A filter needing data the card lacks excludes it. */
export function matchesFilters(card: StrategyCard, f: DiscoverFilters, nowMs: number): boolean {
  if (f.content) {
    if (card.latestAssets.length === 0) return false;
    const mix = basketMix(card);
    if (f.content === "stocks" && mix.stocks < 5000) return false;
    if (f.content === "vaults" && mix.vaults === 0) return false;
    if (f.content === "cash" && mix.cash < 5000) return false;
  }
  if (f.maxDrawdownBps !== null) {
    const drop = card.performance.maxDrawdownBps;
    if (drop === null || Math.abs(drop) >= f.maxDrawdownBps) return false;
  }
  if (f.noLateReveal && card.broken) return false;
  if (f.record === "reveals" && card.revealed < 3) return false;
  if (f.record === "months" && nowMs - Date.parse(card.createdAt) < 90 * DAY_MS) return false;
  if (f.record === "new" && !isNewStrategy(card, nowMs)) return false;
  if (f.maxEmbargoSeconds !== null && card.embargoSeconds > f.maxEmbargoSeconds) return false;
  if (f.price) {
    const usd = priceUsd(card);
    if (f.price === "under5" && usd >= 5) return false;
    if (f.price === "5to20" && (usd < 5 || usd > 20)) return false;
    if (f.price === "over20" && usd <= 20) return false;
  }
  if (f.seatsOpen && card.seatsTaken >= card.seats) return false;
  return true;
}

/** Matches a strategy by name or by an asset in its newest revealed basket. */
export function matchesQuery(card: StrategyCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    card.name.toLowerCase().includes(q) ||
    card.latestAssets.some((asset) => signalAssetInfo(asset).label.toLowerCase().includes(q))
  );
}

const orders: Record<DiscoverSort, (a: StrategyCard, b: StrategyCard) => number> = {
  return: (a, b) =>
    (b.performance.cumulativeReturnBps ?? 0) - (a.performance.cumulativeReturnBps ?? 0),
  trending: (a, b) =>
    b.social.likes + b.social.comments - (a.social.likes + a.social.comments) ||
    b.commits - a.commits,
  followed: (a, b) => b.seatsTaken - a.seatsTaken,
  newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  cheapest: (a, b) => {
    const gap = BigInt(a.monthlyPriceAtoms) - BigInt(b.monthlyPriceAtoms);
    return gap === 0n ? 0 : gap < 0n ? -1 : 1;
  },
};

/**
 * Orders cards; late reveals always sink. By return, only strategies with enough record are
 * ranked, and the rest follow separately instead of disappearing.
 */
export function sortStrategies(
  cards: readonly StrategyCard[],
  sort: DiscoverSort,
  nowMs: number,
): { ranked: StrategyCard[]; unranked: StrategyCard[] } {
  const ordered = (list: StrategyCard[], by: DiscoverSort) =>
    [...list].sort((a, b) =>
      a.broken !== b.broken ? (a.broken ? 1 : -1) : orders[by](a, b) || a.id - b.id,
    );
  if (sort !== "return") return { ranked: ordered([...cards], sort), unranked: [] };
  return {
    ranked: ordered(
      cards.filter((card) => isRanked(card, nowMs)),
      "return",
    ),
    unranked: ordered(
      cards.filter((card) => !isRanked(card, nowMs)),
      "newest",
    ),
  };
}

/** One removable chip per chosen filter. */
export function activeFilters(
  f: DiscoverFilters,
): { key: keyof DiscoverFilters; label: string; cleared: DiscoverFilters }[] {
  const label = <T>(options: Option<T>[], value: T) =>
    options.find((option) => option.value === value)?.label ?? String(value);
  const chips: { key: keyof DiscoverFilters; label: string; cleared: DiscoverFilters }[] = [];
  if (f.content)
    chips.push({
      key: "content",
      label: label(filterOptions.content, f.content),
      cleared: { ...f, content: null },
    });
  if (f.maxDrawdownBps !== null)
    chips.push({
      key: "maxDrawdownBps",
      label: label(filterOptions.maxDrawdownBps, f.maxDrawdownBps),
      cleared: { ...f, maxDrawdownBps: null },
    });
  if (f.noLateReveal)
    chips.push({
      key: "noLateReveal",
      label: "No late reveals",
      cleared: { ...f, noLateReveal: false },
    });
  if (f.record)
    chips.push({
      key: "record",
      label: label(filterOptions.record, f.record),
      cleared: { ...f, record: null },
    });
  if (f.maxEmbargoSeconds !== null)
    chips.push({
      key: "maxEmbargoSeconds",
      label: `Reveals ${label(filterOptions.maxEmbargoSeconds, f.maxEmbargoSeconds).toLowerCase()}`,
      cleared: { ...f, maxEmbargoSeconds: null },
    });
  if (f.price)
    chips.push({
      key: "price",
      label: label(filterOptions.price, f.price),
      cleared: { ...f, price: null },
    });
  if (f.seatsOpen)
    chips.push({ key: "seatsOpen", label: "Seats open", cleared: { ...f, seatsOpen: false } });
  return chips;
}
