import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfiguredOpportunities,
  protocolFacets,
} from "../../src/adapters/catalog/configured-opportunities.ts";
import type {
  Opportunities,
  Opportunity,
} from "../../src/ports/opportunities.port.ts";
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

test("featured Monad AUSD is visible without granting native deposits or fetching unrelated Merkl vaults", async () => {
  const own = {
    chainId: 143,
    address: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    name: "Gizu Prime AUSD",
    featured: true,
  };
  let merklCalls = 0;
  const catalog = new ConfiguredOpportunities(
    [{ id: 143, name: "Monad" }],
    [own],
    {
      list: async () => {
        merklCalls++;
        return { list: [], total: 0 };
      },
      getById: async () => {
        throw new Error("unused");
      },
      tvlRecords: async () => [],
    },
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
  assert.equal(merklCalls, 0);
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
  id: "merkl",
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
function provider(rows = [row]): Opportunities {
  return {
    list: async (q) => ({
      list: rows.slice(q.page * q.items, (q.page + 1) * q.items),
      total: rows.length,
    }),
    getById: async () => {
      throw new Error("unused");
    },
    tvlRecords: async () => [],
  };
}

test("unconfigured chains filter underlying assets before pagination and reject disabled chains", async () => {
  let calls = 0;
  const merkl = provider();
  const catalog = new ConfiguredOpportunities(
    chains,
    [],
    {
      ...merkl,
      list: async (q) => {
        calls++;
        return merkl.list(q);
      },
    },
    { lookup: async () => ({ asset: usdc }) },
  );
  assert.equal((await catalog.list(query)).list[0]?.id, "merkl");
  await assert.rejects(
    catalog.list({ ...query, chainId: 10143 }),
    /not enabled/,
  );
  assert.equal(calls, 1);
});

test("configured contracts merge once across pages, search and protocol filters", async () => {
  const other = {
    ...row,
    id: "other",
    vaultAddress: "0x2222222222222222222222222222222222222222",
  };
  let lookups = 0;
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address, name: "Manual vault", asset: usdc }],
    provider([row, other]),
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

test("Morpho metadata wins, env fills missing fields, unavailable providers are explicit", async () => {
  const merkl = {
    ...provider(),
    list: async () => {
      throw new Error("maintenance");
    },
  };
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
    merkl,
    {
      lookup: async () => ({
        name: "API name",
        netApy: 0.05,
        totalAssetsUsd: 100,
      }),
    },
  );
  const page = await catalog.list(query);
  assert.equal(page.partial, true);
  const detail = await catalog.getById(page.list[0]!.id);
  assert.equal(detail.name, "API name");
  assert.equal(detail.description, "From env");
  assert.equal(detail.totalApr, 5);
  assert.equal(detail.rateType, "apy");
  assert.equal(detail.nativeApr, null);
});

test("configured snapshots are shared, bounded and preserve available pages after a failure", async () => {
  const calls: number[] = [];
  const merkl = {
    ...provider(),
    list: async (q: typeof query & { signal?: AbortSignal }) => {
      calls.push(q.page);
      assert.ok(q.signal instanceof AbortSignal);
      if (q.page === 1) throw new Error("failed page");
      return {
        list: [
          {
            ...row,
            id: `page-${q.page}`,
            vaultAddress:
              q.page === 2
                ? address
                : `0x${(q.page + 2).toString(16).padStart(40, "0")}`,
          },
        ],
        total: 2000,
      };
    },
  };
  const catalog = new ConfiguredOpportunities(chains, [], merkl, {
    lookup: async () => ({ asset: usdc }),
  });
  const [first, second] = await Promise.all([
    catalog.list({ ...query, items: 100 }),
    catalog.list({ ...query, items: 100 }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.partial, true);
  assert.equal(first.total, 1);
  assert.equal(first.list[0]?.id, "page-2");
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("history rejects a disabled-chain detail before fetching records", async () => {
  let historyCalls = 0;
  const merkl = {
    ...provider(),
    getById: async () => ({
      ...row,
      chainId: 10143,
      description: "",
      action: "",
      type: "",
      dailyRewards: 0,
      liveCampaigns: 0,
      nativeApr: 0,
      explorerAddress: address,
      howToSteps: [],
      depositUrl: "",
      identifier: address,
      tags: [],
      tokens: [],
      campaigns: [],
    }),
    tvlRecords: async () => {
      historyCalls++;
      return [];
    },
  };
  const catalog = new ConfiguredOpportunities(chains, [], merkl, {
    lookup: async () => null,
  });
  await assert.rejects(
    catalog.tvlRecords({ id: "wrong-chain", items: 30 }),
    /not enabled/,
  );
  assert.equal(historyCalls, 0);
});

test("native capability filtering happens before pagination and ignores other legitimate USDC vaults", async () => {
  const other = {
    ...row,
    id: "other-usdc",
    vaultAddress: "0x2222222222222222222222222222222222222222",
  };
  const catalog = new ConfiguredOpportunities(
    chains,
    [],
    provider([other, row]),
    {
      lookup: async () => ({ asset: usdc }),
    },
  );
  const first = await catalog.list(query);
  const second = await catalog.list({ ...query, page: 1 });
  assert.equal(first.total, 1);
  assert.equal(first.list[0]?.id, "merkl");
  assert.equal(second.list.length, 0);
  assert.equal(first.list[0]?.asset?.address, usdc.address);
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
    provider([]),
    { lookup: async () => null },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(
    catalog.getById(`configured:1:${address.toLowerCase()}`),
    /not found/,
  );
});

test("configured canonical asset remains available when both metadata providers reject", async () => {
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address, asset: usdc }],
    {
      ...provider(),
      list: async () => {
        throw new Error("Merkl unavailable");
      },
    },
    {
      lookup: async () => {
        throw new Error("Morpho unavailable");
      },
    },
  );
  const page = await catalog.list(query);
  assert.equal(page.partial, true);
  assert.equal(page.total, 1);
  assert.equal(
    (await catalog.getById(page.list[0]!.id)).tokens[0]?.address,
    usdc.address,
  );
});

test("unsupported vaults never trigger metadata lookups regardless of catalog size", async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    ...row,
    id: `vault-${i}`,
    vaultAddress: `0x${(i + 10).toString(16).padStart(40, "0")}`,
  }));
  let active = 0,
    maximum = 0,
    lookups = 0;
  const catalog = new ConfiguredOpportunities(chains, [], provider(rows), {
    lookup: async () => {
      active++;
      lookups++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { asset: usdc };
    },
  });
  const page = await catalog.list({ ...query, items: 100 });
  assert.equal(page.total, 0);
  assert.equal(page.partial, undefined);
  assert.equal(lookups, 0);
  assert.ok(maximum <= 8);
});

test("details and history reject legitimate USDC vaults without native deposit support", async () => {
  let historyCalls = 0;
  const detail = {
    ...row,
    vaultAddress: "0x2222222222222222222222222222222222222222",
    description: "USDC rewards",
    action: "LEND",
    type: "ERC20LOGPROCESSOR",
    dailyRewards: 1,
    liveCampaigns: 1,
    nativeApr: 0,
    explorerAddress: address,
    howToSteps: [],
    depositUrl: "",
    identifier: address,
    tags: [],
    tokens: [{ ...usdc, id: "usdc", price: 1 }],
    campaigns: [],
  };
  const catalog = new ConfiguredOpportunities(
    chains,
    [],
    {
      ...provider([detail]),
      getById: async () => detail,
      tvlRecords: async () => {
        historyCalls++;
        return [];
      },
    },
    { lookup: async () => ({ asset: usdc }) },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(catalog.getById("merkl"), /not found/);
  await assert.rejects(
    catalog.tvlRecords({ id: "merkl", items: 30 }),
    /not found/,
  );
  assert.equal(historyCalls, 0);
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
        {
          ...provider(),
          list: async () => {
            throw new Error("Merkl unavailable");
          },
        },
        { lookup: async () => new Promise(() => {}) },
      );
      const page = await catalog.list(query);
      assert.equal(page.total, 1);
      assert.equal(page.partial, true);
      assert.equal(
        (await catalog.getById(page.list[0]!.id)).asset?.address,
        usdc.address,
      );
    } finally {
      clearTimeout(keepAlive);
    }
  },
);

test("verified Ethereum USDG vaults remain excluded without a native execution profile", async () => {
  const ethereumUsdg = {
    address: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
    name: "Global Dollar",
    symbol: "USDG",
    decimals: 6,
  };
  const vault = {
    ...row,
    id: "grove-usdg",
    chainId: 1,
    chain: chains[0]!,
    vaultAddress: "0xbeef06DB5Aad37A31a99Ae8aE3120618845c5A23",
    tokens: [{ ...ethereumUsdg, id: "usdg", price: 1 }],
    description: "",
    action: "LEND",
    type: "ERC20LOGPROCESSOR",
    dailyRewards: 0,
    liveCampaigns: 0,
    nativeApr: 0,
    explorerAddress: "0xbeef06DB5Aad37A31a99Ae8aE3120618845c5A23",
    howToSteps: [],
    depositUrl: "",
    identifier: "grove-usdg",
    tags: [],
    campaigns: [],
  };
  const catalog = new ConfiguredOpportunities(
    chains,
    [],
    {
      ...provider([vault]),
      getById: async () => vault,
    },
    { lookup: async () => ({ asset: ethereumUsdg }) },
  );
  const page = await catalog.list({ ...query, chainId: 1 });
  assert.equal(page.total, 0);
  await assert.rejects(catalog.getById("grove-usdg"), /not found/);

  const wrongChainAsset = new ConfiguredOpportunities(
    chains,
    [],
    provider([vault]),
    {
      lookup: async () => ({
        asset: {
          ...ethereumUsdg,
          address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        },
      }),
    },
  );
  assert.equal((await wrongChainAsset.list({ ...query, chainId: 1 })).total, 0);
});

test("configured legitimate USDC vaults cannot expand native deposit support", async () => {
  let lookups = 0;
  const other = "0x2222222222222222222222222222222222222222";
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 1, address: other, asset: usdc }],
    provider([]),
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
    provider([]),
    { lookup: async () => null },
  );
  assert.equal((await catalog.list(query)).total, 0);
  await assert.rejects(
    catalog.getById(`configured:1:${address.toLowerCase()}`),
    /not found/,
  );
});

test("enabled chains without native deposit profiles return empty without provider requests", async () => {
  let providerCalls = 0;
  const catalog = new ConfiguredOpportunities(
    chains,
    [{ chainId: 143, address, asset: usdc }],
    {
      ...provider(),
      list: async () => {
        providerCalls++;
        throw new Error("unnecessary Merkl request");
      },
    },
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
    provider([]),
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
