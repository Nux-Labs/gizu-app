import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfiguredOpportunities,
  protocolFacets,
} from "../../src/adapters/catalog/configured-opportunities.ts";
import type { Opportunity } from "../../src/ports/opportunities.port.ts";
import * as catalogConfig from "../../src/domain/catalog.ts";

test("promoted vault configuration adds to default profiles and deduplicates contracts", async () => {
  const resolve = catalogConfig.resolveCatalogVaults;
  const own = {
    chainId: 143,
    address: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    name: "Gizu Prime AUSD",
  };
  const entries = resolve(
    { CATALOG_VAULTS_JSON: [own] },
    catalogConfig.defaultCatalogChains,
  );
  assert.equal(entries.length, 3);
  assert.equal(entries.find((v) => v.chainId === 143)?.featured, true);
  assert.equal(
    resolve({ CATALOG_VAULTS_JSON: [] }, catalogConfig.defaultCatalogChains)
      .length,
    2,
  );
  const promotedDefault = resolve(
    {
      CATALOG_VAULTS_JSON: [
        {
          ...catalogConfig.defaultCatalogVaults[0]!,
          address: catalogConfig.defaultCatalogVaults[0]!.address.toLowerCase(),
          description: "Promoted",
        },
      ],
    },
    catalogConfig.defaultCatalogChains,
  );
  assert.equal(promotedDefault.length, 2);
  assert.equal(promotedDefault[0]?.featured, true);
  assert.equal(promotedDefault[0]?.description, "Promoted");
  assert.equal(
    resolve({ CATALOG_VAULTS_JSON: [own] }, [{ id: 1, name: "Ethereum" }])
      .length,
    1,
  );
});

test("featured Monad AUSD is visible without granting native deposits", async () => {
  const own = {
    chainId: 143,
    address: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    name: "Gizu Prime AUSD",
    featured: true,
  };
  const catalog = new ConfiguredOpportunities(
    [{ id: 143, name: "Monad" }],
    [own],
    { lookup: async () => null },
  );
  const page = await catalog.list({
    protocol: "all",
    search: "",
    page: 0,
    items: 8,
    chainId: 143,
  });
  assert.equal(page.total, 1);
  assert.equal(page.list[0]?.name, own.name);
  assert.equal(page.list[0]?.featured, true);
  assert.equal(page.list[0]?.asset, undefined);
  const detail = await catalog.getById(page.list[0]!.id);
  assert.equal(detail.vaultAddress, own.address);
  assert.equal(detail.totalApr, null);
  assert.deepEqual(await catalog.tvlRecords({ id: detail.id, items: 30 }), []);
  assert.equal(
    (
      await catalog.list({
        protocol: "aave",
        search: "",
        page: 0,
        items: 8,
        chainId: 143,
      })
    ).total,
    0,
  );
});

const address = "0x55C1B6e461a6334B567bAF0FEb5D728715446f05";
const usdc = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  name: "USDC",
  symbol: "USDC",
  decimals: 6,
};
const chains = [
  { id: 1, name: "Ethereum" },
  { id: 143, name: "Monad" },
];
const query = {
  protocol: "all" as const,
  search: "",
  page: 0,
  items: 1,
  chainId: 1,
};
const row: Opportunity = {
  id: "row",
  name: "Existing",
  chainId: 1,
  chain: chains[0]!,
  protocol: { id: "morpho", name: "Morpho" },
  status: "LIVE",
  apr: 1,
  totalApr: 1,
  tvl: 10,
  vaultAddress: address,
};

test("disabled chains are rejected for lists and details", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 4663, address, asset: usdc, featured: true }],
    { lookup: async () => ({ asset: usdc }) },
  );
  await assert.rejects(
    catalog.list({ ...query, chainId: 10143 }),
    /not enabled/,
  );
  await assert.rejects(
    catalog.getById(`configured:4663:${address.toLowerCase()}`),
    /not enabled/,
  );
  await assert.rejects(
    catalog.tvlRecords({ id: `configured:4663:${address.toLowerCase()}`, items: 30 }),
    /not enabled/,
  );
});

test("configured vaults page, search and filter by protocol", async () => {
  let lookups = 0;
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address, name: "Manual vault", asset: usdc }],
    {
      lookup: async () => {
        lookups++;
        return { asset: usdc };
      },
    },
  );
  const first = await catalog.list(query);
  const second = await catalog.list({ ...query, page: 1 });
  assert.equal(first.total, 1);
  assert.equal(first.list[0]!.name, "Manual vault");
  assert.equal(first.list[0]!.totalApr, null);
  assert.equal(first.list[0]!.vaultAddress, address);
  assert.equal(second.list.length, 0);
  assert.equal(lookups, 1);
  assert.equal((await catalog.list({ ...query, search: "manual" })).total, 1);
  assert.equal((await catalog.list({ ...query, protocol: "aave" })).total, 0);
  const detail = await catalog.getById(first.list[0]!.id);
  assert.equal(detail.explorerAddress, address);
  assert.equal(detail.tokens[0]?.address, usdc.address);
  assert.deepEqual(await catalog.tvlRecords({ id: detail.id, items: 30 }), []);
  await assert.rejects(
    catalog.getById(`configured:1:0x3333333333333333333333333333333333333333`),
  );
});

test("Morpho metadata wins and env fills missing fields", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [
      {
        chainId: 1,
        address,
        name: "Fallback",
        description: "From env",
        asset: usdc,
      },
    ],
    {
      lookup: async () => ({
        name: "API name",
        netApy: 0.05,
        totalAssetsUsd: 100,
      }),
    },
  );
  const page = await catalog.list(query);
  assert.equal(page.partial, undefined);
  const detail = await catalog.getById(page.list[0]!.id);
  assert.equal(detail.name, "API name");
  assert.equal(detail.description, "From env");
  assert.equal(detail.totalApr, 5);
  assert.equal(detail.rateType, "apy");
  assert.equal(detail.nativeApr, null);
});

test("configured unsupported assets and unknown underlying assets are inaccessible in lists and details", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [
      {
        chainId: 1,
        address,
        name: "USDC named AUSD vault",
        asset: {
          ...usdc,
          address: "0x3333333333333333333333333333333333333333",
          symbol: "AUSD",
        },
      },
    ],
    { lookup: async () => null },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(
    catalog.getById(`configured:1:${address.toLowerCase()}`),
    /not found/,
  );
});

test("configured canonical asset remains available when Morpho rejects", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address, asset: usdc }],
    {
      lookup: async () => {
        throw new Error("Morpho unavailable");
      },
    },
  );
  const page = await catalog.list(query);
  assert.equal(page.partial, undefined);
  assert.equal(page.total, 1);
  assert.equal(
    (await catalog.getById(page.list[0]!.id)).tokens[0]?.address,
    usdc.address,
  );
});

test("ids outside the configured catalog are not found", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address, asset: usdc }],
    { lookup: async () => ({ asset: usdc }) },
  );
  await assert.rejects(catalog.getById("unknown-opportunity"), /not found/);
  await assert.rejects(
    catalog.tvlRecords({ id: "unknown-opportunity", items: 30 }),
    /not found/,
  );
});

test(
  "a hung metadata provider cannot block configured vault fallback",
  { timeout: 7_000 },
  async () => {
    // Keep the event loop alive while the production unref'ed AbortSignal deadline runs.
    const keepAlive = setTimeout(() => {}, 6_000);
    try {
      const catalog = new ConfiguredOpportunities(
        chains,
        [{ chainId: 1, address, asset: usdc }],
        { lookup: async () => new Promise(() => {}) },
      );
      const page = await catalog.list(query);
      assert.equal(page.total, 1);
      assert.equal(page.partial, undefined);
      assert.equal(
        (await catalog.getById(page.list[0]!.id)).asset?.address,
        usdc.address,
      );
    } finally {
      clearTimeout(keepAlive);
    }
  },
);

test("configured legitimate USDC vaults cannot expand native deposit support", async () => {
  let lookups = 0;
  const other = "0x2222222222222222222222222222222222222222";
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address: other, asset: usdc }],
    {
      lookup: async () => {
        lookups++;
        return { asset: usdc };
      },
    },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(catalog.getById(`configured:1:${other}`), /not found/);
  await assert.rejects(
    catalog.tvlRecords({ id: `configured:1:${other}`, items: 30 }),
    /not found/,
  );
  assert.equal(lookups, 0);
});

test("an approved native vault cannot substitute another canonical stablecoin asset", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [
      {
        chainId: 1,
        address,
        asset: {
          address: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
          name: "Global Dollar",
          symbol: "USDG",
          decimals: 6,
        },
      },
    ],
    { lookup: async () => null },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(
    catalog.getById(`configured:1:${address.toLowerCase()}`),
    /not found/,
  );
});

test("enabled chains without native deposit profiles return empty without metadata requests", async () => {
  let providerCalls = 0;
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 143, address, asset: usdc }],
    {
      lookup: async () => {
        providerCalls++;
        throw new Error("unnecessary Morpho request");
      },
    },
  );
  assert.deepEqual(await catalog.list({ ...query, chainId: 143 }), {
    list: [],
    total: 0,
    facets: { protocols: [] },
  });
  await assert.rejects(
    catalog.getById(`configured:143:${address.toLowerCase()}`),
    /not found/,
  );
  assert.equal(providerCalls, 0);
});

test("protocol facets list catalog protocols, apply search and ignore the protocol filter", async () => {
  const featured = (name: string, address: string) => ({
    chainId: 143,
    address,
    name,
    featured: true,
  });
  const catalog = new ConfiguredOpportunities(
    [{ id: 143, name: "Monad" }],
    [
      featured("Gizu Prime AUSD", "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008"),
      featured("Gizu Core USDC", "0x1111111111111111111111111111111111111111"),
    ],
    { lookup: async () => null },
  );
  const base = { ...query, chainId: 143, items: 8 };
  const morpho = [{ id: "morpho", name: "Morpho", count: 2 }];
  assert.deepEqual((await catalog.list(base)).facets, { protocols: morpho });
  const other = await catalog.list({ ...base, protocol: "aave" });
  assert.equal(other.total, 0);
  assert.deepEqual(other.facets, { protocols: morpho });
  assert.deepEqual((await catalog.list({ ...base, search: "prime" })).facets, {
    protocols: [{ id: "morpho", name: "Morpho", count: 1 }],
  });
});

test("protocol facets count rows per protocol, most vaults first", () => {
  const protocol = (id: string, name: string) => ({ ...row, protocol: { id, name } });
  assert.deepEqual(
    protocolFacets([
      protocol("curvance", "Curvance"),
      protocol("morpho", "Morpho"),
      protocol("aave", "Aave"),
      protocol("morpho", "Morpho"),
    ]),
    [
      { id: "morpho", name: "Morpho", count: 2 },
      { id: "aave", name: "Aave", count: 1 },
      { id: "curvance", name: "Curvance", count: 1 },
    ],
  );
});
