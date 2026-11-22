import { getAddress, parseAbi, type Address, type Hex } from "viem";
import type { AssetPrices, SealedStrategyAsset } from "../../domain/strategy.ts";
import type { StrategyPriceSource } from "../../ports/strategies.port.ts";
import type { StockChainId } from "../oneinch/token-details.ts";
import { STRATEGY_BASE_USDC, STRATEGY_VAULT_ASSET_DECIMALS } from "./universe.ts";

const vaultAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

/** The part of a viem public client a share-price read needs. */
export type VaultReader = {
  readContract(args: {
    address: Address;
    abi: typeof vaultAbi;
    functionName: "decimals" | "convertToAssets";
    args?: readonly [bigint];
  }): Promise<unknown>;
};

/**
 * Prices a basket at one moment: stocks from the 1inch prices the swap list already uses, Base
 * USDC at $1, and Earn vault shares from their ERC-4626 conversion into a $1 stablecoin. A failure
 * leaves that asset unpriced instead of failing the snapshot.
 */
export class StrategyPrices implements StrategyPriceSource {
  constructor(
    private readonly stocks: { prices(chainId: StockChainId): Promise<Map<string, number | null>> },
    private readonly vaultReaders: ReadonlyMap<number, VaultReader>,
  ) {}

  async prices(assets: readonly SealedStrategyAsset[]): Promise<AssetPrices> {
    const stockChains = [
      ...new Set(
        assets
          .filter((asset) => asset.kind === 0 && !isBaseUsdc(asset))
          .map((asset) => asset.chainId as StockChainId),
      ),
    ];
    const stockPrices = new Map(
      await Promise.all(
        stockChains.map(
          async (chainId) =>
            [chainId, await this.stocks.prices(chainId).catch(() => new Map<string, number | null>())] as const,
        ),
      ),
    );
    const entries = await Promise.all(
      assets.map(async (asset): Promise<[Hex, number | null]> => {
        if (asset.kind === 1) return [asset.assetId, await this.sharePrice(asset)];
        if (isBaseUsdc(asset)) return [asset.assetId, 1];
        const price = stockPrices.get(asset.chainId as StockChainId)?.get(asset.address.toLowerCase());
        return [asset.assetId, typeof price === "number" && price > 0 ? price : null];
      }),
    );
    return Object.fromEntries(entries);
  }

  private async sharePrice(asset: SealedStrategyAsset): Promise<number | null> {
    const reader = this.vaultReaders.get(asset.chainId);
    if (!reader) return null;
    try {
      const decimals = Number(
        await reader.readContract({ address: asset.address, abi: vaultAbi, functionName: "decimals" }),
      );
      const assetsPerShare = (await reader.readContract({
        address: asset.address,
        abi: vaultAbi,
        functionName: "convertToAssets",
        args: [10n ** BigInt(decimals)],
      })) as bigint;
      const price = Number(assetsPerShare) / 10 ** STRATEGY_VAULT_ASSET_DECIMALS;
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}

function isBaseUsdc(asset: SealedStrategyAsset): boolean {
  return asset.chainId === 8453 && getAddress(asset.address) === STRATEGY_BASE_USDC;
}
