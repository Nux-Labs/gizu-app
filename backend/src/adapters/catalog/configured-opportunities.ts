import type { CatalogChain, CatalogEntry } from "../../domain/catalog.ts";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import type {
  Opportunities,
  Opportunity,
  OpportunityDetail,
  OpportunityPage,
  ListOpportunitiesQuery,
  ProtocolFacet,
  TvlRecordsQuery,
} from "../../ports/opportunities.port.ts";
import type { VaultMetadata, VaultMetadataSource } from "./morpho-vaults.ts";
import { nativeCatalogAsset, nativeCatalogProfile } from "./native-catalog.ts";

const TTL_MS = 5 * 60 * 1000;
const METADATA_CONCURRENCY = 8;
async function mapConcurrent<T, U>(
  rows: T[],
  read: (row: T) => Promise<U>,
): Promise<U[]> {
  const result: U[] = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(rows.length, METADATA_CONCURRENCY) },
      async () => {
        while (next < rows.length) {
          const index = next++;
          result[index] = await read(rows[index]!);
        }
      },
    ),
  );
  return result;
}
const configuredId = (vault: CatalogEntry) =>
  `configured:${vault.chainId}:${vault.address.toLowerCase()}`;

/**
 * The catalog is the configured vault list: built-in native deposit profiles plus explicit
 * promotions. Morpho supplies names, rates, TVL and the underlying asset.
 */
export class ConfiguredOpportunities implements Opportunities {
  private readonly metadata = new Map<
    string,
    { expires: number; promise: Promise<VaultMetadata | null> }
  >();
  private readonly details = new Map<
    string,
    { expires: number; promise: Promise<OpportunityDetail> }
  >();
  constructor(
    private readonly chains: CatalogChain[],
    private readonly vaults: CatalogEntry[],
    private readonly morpho: VaultMetadataSource,
  ) {}

  private chain(id: number): CatalogChain {
    const chain = this.chains.find((chain) => chain.id === id);
    if (!chain)
      throw new DomainError(
        "CATALOG_CHAIN_DISABLED",
        "catalog chain is not enabled",
      );
    return chain;
  }

  async list(query: ListOpportunitiesQuery): Promise<OpportunityPage> {
    this.chain(query.chainId);
    const configured = this.vaults.filter(
      (vault) =>
        vault.chainId === query.chainId &&
        (vault.featured === true ||
          nativeCatalogProfile(vault.chainId, vault.address)),
    );
    const metadataSignal = AbortSignal.timeout(5_000);
    const details = await mapConcurrent(configured, (vault) =>
      this.configuredDetail(vault, metadataSignal),
    );
    const listed = details.filter((row) => row.featured === true || row.asset);
    const search = query.search.toLowerCase().trim();
    const searched = listed.filter(
      (row) =>
        !search ||
        `${row.name} ${row.vaultAddress ?? ""}`.toLowerCase().includes(search),
    );
    const filtered = searched.filter(
      (row) => query.protocol === "all" || row.protocol.id === query.protocol,
    );
    return {
      list: filtered.slice(
        query.page * query.items,
        (query.page + 1) * query.items,
      ),
      total: filtered.length,
      facets: { protocols: protocolFacets(searched) },
    };
  }

  private lookup(
    chainId: number,
    address: string,
    signal = AbortSignal.timeout(5_000),
  ): Promise<VaultMetadata | null> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const cached = this.metadata.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = new Promise<VaultMetadata | null>((resolve) => {
      const abort = () => resolve(null);
      if (signal.aborted) {
        resolve(null);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => this.morpho.lookup(chainId, address, signal))
        .catch(() => null)
        .then((value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
    });
    this.metadata.set(key, { expires: Date.now() + TTL_MS, promise });
    return promise;
  }

  private configuredDetail(
    vault: CatalogEntry,
    signal?: AbortSignal,
  ): Promise<OpportunityDetail> {
    const id = configuredId(vault);
    const cached = this.details.get(id);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = (async (): Promise<OpportunityDetail> => {
      const metadata = await this.lookup(vault.chainId, vault.address, signal);
      const chain = this.chain(vault.chainId);
      const underlying = metadata?.asset ?? vault.asset;
      const asset =
        vault.featured === true
          ? underlying
          : nativeCatalogAsset(vault.chainId, vault.address, underlying);
      const rate =
        metadata?.netApy === undefined ? null : metadata.netApy * 100;
      return {
        id,
        name:
          metadata?.name ??
          vault.name ??
          metadata?.symbol ??
          vault.symbol ??
          `${chain.name} vault ${vault.address.slice(0, 6)}…${vault.address.slice(-4)}`,
        status: "LISTED",
        symbol: metadata?.symbol ?? vault.symbol,
        chainId: chain.id,
        chain,
        protocol: { id: "morpho", name: "Morpho" },
        vaultAddress: vault.address,
        ...(vault.featured === true ? { featured: true } : {}),
        asset,
        rateType: "apy",
        apr: rate,
        totalApr: rate,
        tvl: metadata?.totalAssetsUsd ?? null,
        nativeApr: null,
        dailyRewards: null,
        liveCampaigns: 0,
        description: metadata?.description ?? vault.description ?? "",
        action: "LEND",
        type: "VAULT",
        explorerAddress: vault.address,
        identifier: vault.address,
        depositUrl: vault.depositUrl ?? "",
        howToSteps: vault.howToSteps ?? [],
        tags: vault.tags ?? [],
        tokens: asset ? [{ id: asset.address, ...asset, price: null }] : [],
        campaigns: [],
      };
    })();
    this.details.set(id, { expires: Date.now() + TTL_MS, promise });
    return promise;
  }

  async getById(id: string): Promise<OpportunityDetail> {
    if (id.startsWith("configured:")) {
      const vault = this.vaults.find((vault) => configuredId(vault) === id);
      if (!vault) throw new NotFoundError({ name: "opportunity" }, id);
      this.chain(vault.chainId);
      if (
        vault.featured !== true &&
        !nativeCatalogProfile(vault.chainId, vault.address)
      )
        throw new NotFoundError({ name: "opportunity" }, id);
      const detail = await this.configuredDetail(vault);
      if (vault.featured !== true && !detail.asset)
        throw new NotFoundError({ name: "opportunity" }, id);
      return detail;
    }
    throw new NotFoundError({ name: "opportunity" }, id);
  }

  /** Configured vaults have no TVL history source yet; cards draw a flat line. */
  async tvlRecords(query: TvlRecordsQuery) {
    await this.getById(query.id); // Same enabled-chain / configured-contract boundary as detail.
    return [];
  }
}

/** Options come from listed rows, so unsupported protocols never appear as filters. */
export function protocolFacets(rows: Opportunity[]): ProtocolFacet[] {
  const facets = new Map<string, ProtocolFacet>();
  for (const { protocol } of rows) {
    const facet = facets.get(protocol.id);
    if (facet) facet.count += 1;
    else facets.set(protocol.id, { ...protocol, count: 1 });
  }
  return [...facets.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}
