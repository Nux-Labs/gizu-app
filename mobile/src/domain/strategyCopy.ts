import { earnProfiles, type EarnProfileId } from "@/domain/earn/types";
import { vaultNames } from "@/domain/wallet/portfolioValue";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { strategyStockTargets } from "@/domain/strategyUniverse";
import { BASE_USDC, portfolioHoldings, type SealedAssetView } from "./strategies";

/** Buys below a dollar cost more in fees than they track; they stay in USDC. */
export const MIN_STOCK_BUY_ATOMS = 1_000_000n;
/** A vault deposit funds fresh investment wallets; below this its fees weigh heavily. */
export const SMALL_VAULT_DEPOSIT_ATOMS = 50_000_000n;

export type SignalAssetInfo =
  | { kind: "stock"; chainId: 4663 | 8453; address: string; symbol: string; label: string }
  | { kind: "vault"; profileId: EarnProfileId; label: string }
  | { kind: "cash"; label: string }
  | { kind: "unknown"; label: string };

const assetKey = (chainId: number, kind: number, address: string) =>
  `${chainId}:${kind}:${address.toLowerCase()}`;

/** What a sealed asset is in Gizu's universe; unknown assets are never traded. */
export function signalAssetInfo(
  asset: Pick<SealedAssetView, "chainId" | "kind" | "address">,
): SignalAssetInfo {
  if (
    asset.kind === 0 &&
    asset.chainId === 8453 &&
    asset.address.toLowerCase() === BASE_USDC.toLowerCase()
  )
    return { kind: "cash", label: "USDC" };
  if (asset.kind === 0 && (asset.chainId === 4663 || asset.chainId === 8453)) {
    const chainId = asset.chainId;
    const target = strategyStockTargets[chainId].find(
      (entry) => entry.address.toLowerCase() === asset.address.toLowerCase(),
    );
    if (target)
      return {
        kind: "stock",
        chainId,
        address: target.address,
        symbol: target.symbol,
        label: `${target.symbol} on ${chainId === 8453 ? "Base" : "Robinhood"}`,
      };
  }
  if (asset.kind === 1) {
    const profileId = (Object.keys(earnProfiles) as EarnProfileId[]).find(
      (id) =>
        earnProfiles[id].chainId === asset.chainId &&
        earnProfiles[id].vault.toLowerCase() === asset.address.toLowerCase(),
    );
    if (profileId) return { kind: "vault", profileId, label: `${vaultNames[profileId]} vault` };
  }
  return { kind: "unknown", label: `${asset.address.slice(0, 6)}…${asset.address.slice(-4)}` };
}

export type CopyLeg =
  | {
      kind: "stock";
      chainId: 4663 | 8453;
      address: string;
      symbol: string;
      label: string;
      weightBps: number;
      atoms: bigint;
    }
  | {
      kind: "vault";
      profileId: EarnProfileId;
      label: string;
      weightBps: number;
      atoms: bigint;
      small: boolean;
    }
  | { kind: "cash"; label: string; weightBps: number; atoms: bigint };

export type CopyPlan = {
  /** Buys in basket order, then vault deposits, then what stays in USDC. */
  legs: CopyLeg[];
  /** Held positions above their target; selling them is the owner's choice, not automatic. */
  overweight: {
    label: string;
    symbol: string | null;
    chainId: number;
    address: string;
    excessAtoms: bigint;
  }[];
  /** Assets this app cannot trade, left in USDC. */
  unsupported: string[];
};

/**
 * Turns a basket and a new USDC budget into the buys that bring this portfolio toward the
 * basket's weights. Strategy assets already held count toward their targets, so a later update
 * only buys the difference. Without selling, buys are scaled to the budget; positions above their
 * target are listed instead of sold.
 */
export function copyPlan(
  assets: readonly SealedAssetView[],
  budgetAtoms: bigint,
  snapshot: MainnetPortfolioSnapshot | null,
): CopyPlan {
  const held = new Map<string, bigint>();
  for (const line of snapshot ? portfolioHoldings(snapshot).lines : []) {
    // USDC is what the budget comes from, not a position to rebalance.
    if (line.label === "USDC") continue;
    held.set(assetKey(line.chainId, line.kind, line.address), line.valueAtoms);
  }
  const entries = assets.map((asset) => ({
    asset,
    info: signalAssetInfo(asset),
    held: held.get(assetKey(asset.chainId, asset.kind, asset.address)) ?? 0n,
  }));
  const total = budgetAtoms + entries.reduce((sum, entry) => sum + entry.held, 0n);
  const wants = entries.map((entry) => {
    const target = (total * BigInt(entry.asset.weightBps)) / 10_000n;
    return { ...entry, target, want: target > entry.held ? target - entry.held : 0n };
  });
  const wanted = wants.reduce((sum, entry) => sum + entry.want, 0n);
  const scale = (want: bigint) =>
    wanted > budgetAtoms && wanted > 0n ? (want * budgetAtoms) / wanted : want;

  const stocks: CopyLeg[] = [];
  const vaults: CopyLeg[] = [];
  let cashWeight = 0;
  const unsupported: string[] = [];
  for (const { asset, info, want } of wants) {
    const atoms = scale(want);
    if (info.kind === "stock" && atoms >= MIN_STOCK_BUY_ATOMS)
      stocks.push({ ...info, kind: "stock", weightBps: asset.weightBps, atoms });
    else if (info.kind === "vault" && atoms > 0n)
      vaults.push({
        kind: "vault",
        profileId: info.profileId,
        label: info.label,
        weightBps: asset.weightBps,
        atoms,
        small: atoms < SMALL_VAULT_DEPOSIT_ATOMS,
      });
    else if (info.kind === "unknown") unsupported.push(info.label);
    else if (info.kind === "cash") cashWeight += asset.weightBps;
  }
  // Whatever the buys leave of the budget stays in USDC: the cash weight, buys too small to make
  // and unsupported assets, and rounding.
  const spent = [...stocks, ...vaults].reduce((sum, leg) => sum + leg.atoms, 0n);
  const cash = budgetAtoms > spent ? budgetAtoms - spent : 0n;
  const legs = [...stocks, ...vaults];
  if (cash > 0n) legs.push({ kind: "cash", label: "USDC", weightBps: cashWeight, atoms: cash });

  const overweight = wants.flatMap(({ asset, info, held: value, target }) =>
    value > target && value - target >= MIN_STOCK_BUY_ATOMS && info.kind !== "cash"
      ? [
          {
            label: info.label,
            symbol: info.kind === "stock" ? info.symbol : null,
            chainId: asset.chainId,
            address: asset.address,
            excessAtoms: value - target,
          },
        ]
      : [],
  );
  return { legs, overweight, unsupported };
}

/** "3 hours", "2 days": how long a copy has been behind the newest basket. */
export function behindText(sinceIso: string, nowMs: number): string {
  const minutes = Math.max(1, Math.round((nowMs - Date.parse(sinceIso)) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
