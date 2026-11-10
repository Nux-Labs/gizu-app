import type { CatalogChain, CatalogEntry } from "../../domain/catalog.ts";
import { catalogAddress } from "../../domain/catalog.ts";
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
import {
  nativeCatalogAsset,
  nativeCatalogChain,
  nativeCatalogProfile,
} from "./native-catalog.ts";

const TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_ITEMS = 100;
const MAX_SNAPSHOT_PAGES = 10;
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
export function contractAddress(row: Opportunity): string | undefined {
  const fields = row as Opportunity & {
    explorerAddress?: string;
    identifier?: string;
  };
  for (const value of [
    fields.vaultAddress,
    fields.explorerAddress,
    fields.identifier,
  ]) {
    if (catalogAddress.safeParse(value).success) return value;
  }
  return undefined;
}
const configuredId = (vault: CatalogEntry) =>
  `configured:${vault.chainId}:${vault.address.toLowerCase()}`;

export class ConfiguredOpportunities implements Opportunities {
  private readonly metadata = new Map<
    string,
    { expires: number; promise: Promise<VaultMetadata | null> }
  >();
  private readonly snapshots = new Map<
    number,
    { expires: number; promise: Promise<OpportunityPage> }
  >();
  private readonly details = new Map<
    string,
    { expires: number; promise: Promise<OpportunityDetail> }
  >();
  constructor(
    private readonly chains: CatalogChain[],
    private readonly vaults: CatalogEntry[],
    private readonly merkl: Opportunities,
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
    const [snapshot, additions] = await Promise.all([
      this.snapshot(query.chainId),
      mapConcurrent(configured, (vault) =>
        this.configuredDetail(vault, metadataSignal),
      ),
    ]);
    const addresses = new Set(
      configured.map((vault) => vault.address.toLowerCase()),
    );
    const combined = [
      ...additions.filter((row) => row.featured === true || row.asset),
      ...snapshot.list.filter(
        (row) => !addresses.has(contractAddress(row)?.toLowerCase() ?? ""),
      ),
    ];
    const search = query.search.toLowerCase().trim();
    const searched = combined.filter(
      (row) =>
        !search ||
        `${row.name} ${contractAddress(row) ?? ""}`
          .toLowerCase()
          .includes(search),
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
      ...(snapshot.partial ? { partial: true } : {}),
      facets: { protocols: protocolFacets(searched) },
    };
  }

  private snapshot(chainId: number): Promise<OpportunityPage> {
    if (!nativeCatalogChain(chainId))
      return Promise.resolve({ list: [], total: 0 });
    const cached = this.snapshots.get(chainId);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = (async () => {
      const rows = new Map<string, Opportunity>();
      const signal = AbortSignal.timeout(8_000);
      const read = (page: number) =>
        this.merkl.list({
          chainId,
          protocol: "all",
          search: "",
          page,
          items: SNAPSHOT_ITEMS,
          signal,
        });
      const append = (result: OpportunityPage) => {
        for (const row of result.list) {
          const address = contractAddress(row);
          if (
            row.chainId !== chainId ||
            row.protocol.id !== "morpho" ||
            !address ||
            !nativeCatalogProfile(chainId, address)
          )
            continue;
          const key = address.toLowerCase();
          if (!rows.has(key))
            rows.set(key, {
              ...row,
              vaultAddress: address,
              featured: undefined,
            });
        }
      };
      try {
        const first = await read(0);
        append(first);
        const pages = Math.min(
          MAX_SNAPSHOT_PAGES,
          Math.ceil(first.total / SNAPSHOT_ITEMS),
        );
        const results = await Promise.allSettled(
          Array.from({ length: Math.max(0, pages - 1) }, (_, i) => read(i + 1)),
        );
        let partial =
          first.total > MAX_SNAPSHOT_PAGES * SNAPSHOT_ITEMS ||
          first.partial === true;
        for (const result of results) {
          if (result.status === "fulfilled") {
            append(result.value);
            if (result.value.partial) partial = true;
          } else partial = true;
        }
        const candidates = [...rows.values()];
        const verified = await mapConcurrent(candidates, async (row) => {
          if (signal.aborted) {
            partial = true;
            return null;
          }
          const metadata = await this.lookup(
            chainId,
            contractAddress(row)!,
            signal,
          );
          const asset = nativeCatalogAsset(
            chainId,
            contractAddress(row)!,
            metadata?.asset,
          );
          if (!metadata?.asset) partial = true;
          return asset ? { ...row, asset } : null;
        });
        const list = verified.filter((row) => row !== null);
        return {
          list,
          total: list.length,
          ...(partial ? { partial: true } : {}),
        };
      } catch {
        /* Keep configured entries accessible when Merkl is unavailable. */
      }
      return { list: [], total: 0, partial: true };
    })();
    this.snapshots.set(chainId, { expires: Date.now() + TTL_MS, promise });
    return promise;
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
    const detail = await this.merkl.getById(id);
    this.chain(detail.chainId);
    const address = contractAddress(detail);
    if (
      detail.protocol.id !== "morpho" ||
      !address ||
      !nativeCatalogProfile(detail.chainId, address)
    )
      throw new NotFoundError({ name: "opportunity" }, id);
    const metadata = await this.lookup(detail.chainId, address);
    const asset = nativeCatalogAsset(detail.chainId, address, metadata?.asset);
    if (!asset) throw new NotFoundError({ name: "opportunity" }, id);
    return { ...detail, vaultAddress: address, asset };
  }

  async tvlRecords(query: TvlRecordsQuery) {
    await this.getById(query.id); // Same enabled-chain / configured-contract boundary as detail.
    return query.id.startsWith("configured:")
      ? []
      : this.merkl.tvlRecords(query);
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
