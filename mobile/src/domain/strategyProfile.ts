import type { SealedAssetView, StrategyCard, StrategyHistoryEntry } from "./strategies";
import { signalAssetInfo } from "./strategyCopy";

const DAY_MS = 86_400_000;

/** A strategy younger than this, or with fewer reveals, is new: its record is still short. */
export const NEW_STRATEGY_DAYS = 30;
export const NEW_STRATEGY_REVEALS = 3;
/** Rankings by return only list strategies with enough record to compare. */
export const RANKED_MIN_REVEALS = 3;
export const RANKED_MIN_DAYS = 14;

export type BasketChange =
  | { kind: "added"; label: string; toBps: number }
  | { kind: "removed"; label: string; fromBps: number }
  | { kind: "changed"; label: string; fromBps: number; toBps: number };

const key = (asset: SealedAssetView) =>
  `${asset.chainId}:${asset.kind}:${asset.address.toLowerCase()}`;

/** What one update changed against the update before it; largest moves first. */
export function basketChanges(
  previous: readonly SealedAssetView[] | null,
  next: readonly SealedAssetView[],
): BasketChange[] {
  const before = new Map((previous ?? []).map((asset) => [key(asset), asset]));
  const after = new Map(next.map((asset) => [key(asset), asset]));
  const changes: (BasketChange & { move: number })[] = [];
  for (const [id, asset] of after) {
    const label = signalAssetInfo(asset).label;
    const old = before.get(id);
    if (!old) changes.push({ kind: "added", label, toBps: asset.weightBps, move: asset.weightBps });
    else if (old.weightBps !== asset.weightBps)
      changes.push({
        kind: "changed",
        label,
        fromBps: old.weightBps,
        toBps: asset.weightBps,
        move: Math.abs(asset.weightBps - old.weightBps),
      });
  }
  for (const [id, asset] of before)
    if (!after.has(id))
      changes.push({
        kind: "removed",
        label: signalAssetInfo(asset).label,
        fromBps: asset.weightBps,
        move: asset.weightBps,
      });
  return changes
    .sort((a, b) => b.move - a.move || a.label.localeCompare(b.label))
    .map(({ move: _move, ...change }) => change);
}

const pct = (bps: number) => `${bps / 100}%`;

export function changeText(change: BasketChange): string {
  if (change.kind === "added") return `+${change.label} ${pct(change.toBps)}`;
  if (change.kind === "removed") return `${change.label} out`;
  return `${change.label} ${pct(change.fromBps)} → ${pct(change.toBps)}`;
}

/** Revealed updates oldest first, each paired with the basket it replaced. */
export function revealedUpdates(history: readonly StrategyHistoryEntry[]) {
  const revealed = history
    .filter((entry) => entry.revealedAt !== null)
    .sort((a, b) => a.seq - b.seq);
  return revealed.map((entry, i) => ({
    entry,
    previous: i > 0 ? revealed[i - 1]!.assets : null,
  }));
}

/** Growth of 100 through each closed, priced period, starting at 100. */
export function returnSeries(history: readonly StrategyHistoryEntry[]): number[] {
  const series = [100];
  for (const { entry } of revealedUpdates(history)) {
    if (entry.periodReturnBps === null) continue;
    series.push(series[series.length - 1]! * (1 + entry.periodReturnBps / 10_000));
  }
  return series;
}

/** Average days between sealed updates; null with fewer than two. */
export function updateCadenceDays(history: readonly StrategyHistoryEntry[]): number | null {
  const times = history
    .map((entry) => (entry.committedAt ? Date.parse(entry.committedAt) : NaN))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  return (times[times.length - 1]! - times[0]!) / (times.length - 1) / DAY_MS;
}

export function cadenceText(days: number | null): string {
  if (days === null) return "—";
  if (days < 1) return `every ${Math.max(1, Math.round(days * 24))}h`;
  return `every ${Math.round(days)}d`;
}

/** "3 days", "5 hours", "12 minutes" or "less than a minute". */
export function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

/** "just now", "5m ago", "3h ago", "2d ago" or the date for older moments. */
export function agoText(iso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Sealed updates still under embargo. Only the newest commit time is public, so the next reveal
 * is known exactly when one update is waiting.
 */
export function pendingReveal(card: StrategyCard, nowMs: number) {
  const waiting = Math.max(0, card.commits - card.revealed);
  if (waiting === 0 || !card.lastCommitAt) return waiting === 0 ? null : { waiting, inMs: null };
  const at = Date.parse(card.lastCommitAt) + card.embargoSeconds * 1000;
  return { waiting, inMs: waiting === 1 ? Math.max(0, at - nowMs) : null };
}

export function isNewStrategy(card: StrategyCard, nowMs: number): boolean {
  const age = nowMs - Date.parse(card.createdAt);
  return age < NEW_STRATEGY_DAYS * DAY_MS || card.revealed < NEW_STRATEGY_REVEALS;
}

/** Enough revealed record and age to sit in a ranking by return. */
export function isRanked(card: StrategyCard, nowMs: number): boolean {
  const age = nowMs - Date.parse(card.createdAt);
  return (
    !card.broken &&
    card.revealed >= RANKED_MIN_REVEALS &&
    age >= RANKED_MIN_DAYS * DAY_MS &&
    card.performance.cumulativeReturnBps !== null
  );
}

/** Two stable colours from a signer address, for an avatar that needs no upload. */
export function avatarColors(signer: string): [string, string] {
  const hex = signer.toLowerCase().replace(/^0x/, "").padEnd(12, "0");
  const hue = (offset: number) => parseInt(hex.slice(offset, offset + 3), 16) % 360;
  const first = hue(0);
  const second = (first + 40 + (hue(3) % 120)) % 360;
  return [`hsl(${first}, 70%, 55%)`, `hsl(${second}, 70%, 45%)`];
}

export function percentText(bps: number): string {
  return `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
}
