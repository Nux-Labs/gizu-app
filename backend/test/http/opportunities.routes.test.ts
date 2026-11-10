import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import { OpportunitiesController } from "../../src/http/controllers/opportunities.controller.ts";
import { mapRequestError } from "../../src/http/map-request-error.ts";
import { registerOpportunityRoutes } from "../../src/http/routes/opportunities.routes.ts";
import type { Cache } from "../../src/ports/cache.port.ts";
import type { ListOpportunitiesQuery } from "../../src/ports/opportunities.port.ts";
import { GetOpportunityTvlRecordsUseCase } from "../../src/usecase/opportunities/get-opportunity-tvl-records.usecase.ts";
import { GetOpportunityUseCase } from "../../src/usecase/opportunities/get-opportunity.usecase.ts";
import { ListOpportunitiesUseCase } from "../../src/usecase/opportunities/list-opportunities.usecase.ts";
import { ConfiguredOpportunities } from "../../src/adapters/catalog/configured-opportunities.ts";
import {
  resolveCatalogChains,
  resolveCatalogVaults,
  defaultCatalogVaults,
} from "../../src/domain/catalog.ts";

test("lists the three protocols and scopes each opportunity request", async () => {
  const queries: ListOpportunitiesQuery[] = [];
  const cache: Cache = {
    get: async () => null,
    set: async () => {},
    deleteExpired: async () => 0,
  };
  const opportunities = {
    list: async (query: ListOpportunitiesQuery) => {
      queries.push(query);
      return { list: [], total: 0 };
    },
    getById: async () => {
      throw new Error("unused");
    },
    tvlRecords: async () => [],
  };
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  registerOpportunityRoutes(
    app,
    new OpportunitiesController(
      new ListOpportunitiesUseCase(opportunities, cache),
      new GetOpportunityUseCase(opportunities, cache),
      new GetOpportunityTvlRecordsUseCase(opportunities, cache),
    ),
    [
      { id: 4663, name: "Robinhood" },
      { id: 1, name: "Ethereum" },
      { id: 143, name: "Monad" },
    ],
  );

  const chains = await app.inject({ method: "GET", url: "/v1/chains" });
  assert.equal(chains.statusCode, 200);
  assert.deepEqual(chains.json(), {
    list: [
      { id: 4663, name: "Robinhood" },
      { id: 1, name: "Ethereum" },
      { id: 143, name: "Monad" },
    ],
  });

  const catalog = await app.inject({ method: "GET", url: "/v1/protocols" });
  assert.equal(catalog.statusCode, 200);
  assert.deepEqual(catalog.json(), {
    list: [
      { id: "aave", name: "Aave" },
      { id: "morpho", name: "Morpho" },
      { id: "curvance", name: "Curvance" },
    ],
  });

  for (const protocolId of ["aave", "morpho", "curvance"]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/protocols/${protocolId}/opportunities?search=&page=0&items=20&chainId=143`,
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    queries.map((query) => query.protocol),
    ["aave", "morpho", "curvance"],
  );

  const unsupported = await app.inject({
    method: "GET",
    url: "/v1/protocols/euler/opportunities?search=&page=0&items=20&chainId=143",
  });
  assert.equal(unsupported.statusCode, 400);
  assert.deepEqual(unsupported.json(), {
    code: "VALIDATION_ERROR",
    message: "invalid request",
  });

  const oversizedPage = await app.inject({
    method: "GET",
    url: "/v1/protocols/aave/opportunities?search=&page=0&items=101&chainId=143",
  });
  assert.equal(oversizedPage.statusCode, 400);
  assert.equal(queries.length, 3);
  await app.close();
});

test("VAULT_CHAINS exposes Ethereum/Robinhood and pinned USDC/USDG vault details during outages", async () => {
  const cache: Cache = {
    get: async () => null,
    set: async () => {},
    deleteExpired: async () => 0,
  };
  const unsupportedAddress = "0x2222222222222222222222222222222222222222";
  const selectedChains = resolveCatalogChains({
    VAULT_CHAINS: [1, 4663],
    CATALOG_CHAINS_JSON: [{ id: 143, name: "Monad" }],
  });
  const opportunities = new ConfiguredOpportunities(
    selectedChains,
    [
      ...defaultCatalogVaults,
      {
        chainId: 1,
        address: unsupportedAddress,
        name: "Other legitimate USDC vault",
        asset: {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          name: "USD Coin",
          symbol: "USDC",
          decimals: 6,
        },
      },
    ],
    {
      lookup: async () => {
        throw new Error("Morpho unavailable");
      },
    },
  );
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  registerOpportunityRoutes(
    app,
    new OpportunitiesController(
      new ListOpportunitiesUseCase(opportunities, cache),
      new GetOpportunityUseCase(opportunities, cache),
      new GetOpportunityTvlRecordsUseCase(opportunities, cache),
    ),
    selectedChains,
  );
  const chains = await app.inject({ method: "GET", url: "/v1/chains" });
  assert.deepEqual(
    chains.json().list.map((chain: { id: number }) => chain.id),
    [1, 4663],
  );
  const inactive = await app.inject({
    method: "GET",
    url: "/v1/opportunities?chainId=143&page=0&items=20",
  });
  assert.equal(inactive.statusCode, 400);
  for (const [chainId, symbol, contract, asset] of [
    [
      4663,
      "USDG",
      "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    ],
    [
      1,
      "USDC",
      "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    ],
  ]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/opportunities?search=&page=0&items=20&chainId=${chainId}`,
    });
    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.equal(page.total, 1);
    assert.equal(page.partial, undefined);
    assert.equal(page.list[0].vaultAddress, contract);
    assert.equal(page.list[0].asset.symbol, symbol);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${encodeURIComponent(page.list[0].id)}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().opportunity.asset.address, asset);
    assert.equal(detail.json().opportunity.tokens[0].address, asset);
    assert.equal(detail.json().opportunity.totalApr, null);
  }
  const unsupportedId = `configured:1:${unsupportedAddress}`;
  const unsupportedDetail = await app.inject({
    method: "GET",
    url: `/v1/opportunities/${encodeURIComponent(unsupportedId)}`,
  });
  assert.equal(unsupportedDetail.statusCode, 404);
  const unsupportedHistory = await app.inject({
    method: "GET",
    url: `/v1/opportunities/${encodeURIComponent(unsupportedId)}/tvl-records?items=30`,
  });
  assert.equal(unsupportedHistory.statusCode, 404);
  await app.close();
});

test("a Monad promotion adds to Ethereum/Robinhood vault routes without replacing them", async () => {
  const chains = resolveCatalogChains({ VAULT_CHAINS: [1, 4663, 143] });
  const own = {
    chainId: 143,
    address: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    name: "Gizu Prime AUSD",
  };
  const entries = resolveCatalogVaults({ CATALOG_VAULTS_JSON: [own] }, chains);
  const adapter = new ConfiguredOpportunities(
    chains,
    entries,
    { lookup: async () => null },
  );
  const cache: Cache = {
    get: async () => null,
    set: async () => {},
    deleteExpired: async () => 0,
  };
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  registerOpportunityRoutes(
    app,
    new OpportunitiesController(
      new ListOpportunitiesUseCase(adapter, cache),
      new GetOpportunityUseCase(adapter, cache),
      new GetOpportunityTvlRecordsUseCase(adapter, cache),
    ),
    chains,
  );
  for (const chain of chains) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/opportunities?chainId=${chain.id}&search=&page=0&items=8`,
    });
    assert.equal(response.statusCode, 200);
    const { list, total } = response.json();
    assert.equal(total, 1);
    assert.equal(list[0].featured === true, chain.id === 143);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${encodeURIComponent(list[0].id)}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().opportunity.featured === true, chain.id === 143);
    if (chain.id === 143) assert.equal(list[0].name, "Gizu Prime AUSD");
    else assert.ok(["USDC", "USDG"].includes(list[0].asset.symbol));
  }
  await app.close();
});

test("the opportunity list accepts a catalog protocol filter and returns its facets", async () => {
  const queries: ListOpportunitiesQuery[] = [];
  const facets = { protocols: [{ id: "morpho", name: "Morpho", count: 2 }] };
  const opportunities = {
    list: async (query: ListOpportunitiesQuery) => {
      queries.push(query);
      return { list: [], total: 0, facets };
    },
    getById: async () => {
      throw new Error("unused");
    },
    tvlRecords: async () => [],
  };
  const cache: Cache = {
    get: async () => null,
    set: async () => {},
    deleteExpired: async () => 0,
  };
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(mapRequestError);
  registerOpportunityRoutes(
    app,
    new OpportunitiesController(
      new ListOpportunitiesUseCase(opportunities, cache),
      new GetOpportunityUseCase(opportunities, cache),
      new GetOpportunityTvlRecordsUseCase(opportunities, cache),
    ),
    [{ id: 143, name: "Monad" }],
  );
  const base = "/v1/opportunities?search=&page=0&items=8&chainId=143";
  const all = await app.inject({ method: "GET", url: base });
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.json().facets, facets);
  const scoped = await app.inject({ method: "GET", url: `${base}&protocol=morpho` });
  assert.equal(scoped.statusCode, 200);
  assert.deepEqual(
    queries.map((query) => query.protocol),
    ["all", "morpho"],
  );
  const invalid = await app.inject({ method: "GET", url: `${base}&protocol=Bad%20id` });
  assert.equal(invalid.statusCode, 400);
  assert.equal(queries.length, 2);
  await app.close();
});
