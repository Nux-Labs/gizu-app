import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { registerTokenRoutes } from "../../src/http/routes/tokens.routes.ts";

test("GET /v1/tokens filters, paginates, and validates explicit query fields", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerTokenRoutes(app, { list: async () => [
    { chainId: 143, address: "0x1111111111111111111111111111111111111111", symbol: "AAPLx", name: "Apple xStock", decimals: 18, logoURI: null, category: "rwa", issuer: null, swapListed: true, buyable: false, fusionStatus: "quote-required" },
    { chainId: 143, address: "0x2222222222222222222222222222222222222222", symbol: "MSFTx", name: "Microsoft xStock", decimals: 18, logoURI: null, category: "rwa", issuer: null, swapListed: true, buyable: false, fusionStatus: "quote-required" },
    { chainId: 143, address: "0x3333333333333333333333333333333333333333", symbol: "USDC", name: "USD Coin", decimals: 6, logoURI: null, category: "other", issuer: null, swapListed: true, buyable: false, fusionStatus: "quote-required" },
  ] });
  const good = await app.inject("/v1/tokens?chainId=143&category=rwa&search=xstock&page=1&items=1");
  assert.equal(good.statusCode, 200);
  assert.deepEqual({ symbols: good.json().list.map((token: {symbol: string}) => token.symbol), total: good.json().total, page: good.json().page, items: good.json().items }, {
    symbols: ["MSFTx"], total: 2, page: 1, items: 1,
  });
  const defi = await app.inject("/v1/tokens?chainId=143&category=other&search=&page=0&items=10");
  assert.equal(defi.statusCode, 200);
  const bad = await app.inject("/v1/tokens?chainId=999&category=all&search=&page=0&items=60");
  assert.equal(bad.statusCode, 400);
  const missingCategory = await app.inject("/v1/tokens?chainId=143&search=&page=0&items=60");
  assert.equal(missingCategory.statusCode, 400);
  const badItems = await app.inject("/v1/tokens?chainId=143&category=all&search=&page=0&items=101");
  assert.equal(badItems.statusCode, 400);
  await app.close();
});

test("GET /v1/tokens without chainId merges every catalog chain, Robinhood first", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const calls: Array<[number, string]> = [];
  registerTokenRoutes(app, { list: async (chainId, category) => {
    calls.push([chainId, category]);
    return [{ chainId, address: `0x${String(chainId).padStart(40, "0")}`, symbol: `T${chainId}`, name: "Token", decimals: 18, logoURI: null, category: "rwa", issuer: null, swapListed: true, buyable: false, fusionStatus: "quote-required" }];
  } });
  const all = await app.inject("/v1/tokens?category=rwa&search=&page=0&items=10");
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.json().list.map((token: {symbol: string}) => token.symbol), ["T4663", "T143", "T1"]);
  assert.equal(all.json().total, 3);
  assert.deepEqual(calls, [[4663, "rwa"], [143, "rwa"], [1, "rwa"]]);
  await app.close();
});

test("GET /v1/tokens with liquidOnly lists only tokens a buy can target", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const token = (symbol: string, issuer: "Robinhood" | null, buyable: boolean) => ({ chainId: 4663, address: `0x${symbol.padStart(40, "0")}`, symbol, name: symbol, decimals: 18, logoURI: null, category: "rwa" as const, issuer, swapListed: true, buyable, fusionStatus: "quote-required" as const });
  registerTokenRoutes(app, { list: async () => [token("AAA", "Robinhood", true), token("BBB", "Robinhood", false), token("CCC", null, false)] });
  const symbols = async (url: string) => (await app.inject(url)).json().list.map((t: { symbol: string }) => t.symbol);
  assert.deepEqual(await symbols("/v1/tokens?chainId=4663&category=rwa&search=&page=0&items=10&liquidOnly=true"), ["AAA"]);
  assert.deepEqual(await symbols("/v1/tokens?chainId=4663&category=rwa&search=&page=0&items=10"), ["AAA", "BBB", "CCC"]);
  assert.equal((await app.inject("/v1/tokens?chainId=4663&category=rwa&search=&page=0&items=10&liquidOnly=yes")).statusCode, 400);
  await app.close();
});

test("GET /v1/tokens/4663/:address/details serves buy targets, 404s others and validates the period", async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const asked: Array<[string, string]> = [];
  const known = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  registerTokenRoutes(app, { list: async () => [] }, { details: async (address, period) => {
    asked.push([address, period]);
    return address === known ? { chainId: 4663, address, symbol: "NVDA", name: "NVIDIA", logoURI: "https://x/y.png", kind: "stock", description: "d", isin: null, sharesPerToken: null, sessions: { regular: true, extended: false, overnight: false }, priceUsd: 1, chart: null } : undefined;
  } });
  const ok = await app.inject(`/v1/tokens/4663/${known}/details?period=1W`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().symbol, "NVDA");
  assert.equal((await app.inject(`/v1/tokens/4663/${known}/details`)).statusCode, 200);
  assert.deepEqual(asked, [[known, "1W"], [known, "1M"]]);
  assert.equal((await app.inject("/v1/tokens/4663/0x1111111111111111111111111111111111111111/details")).statusCode, 404);
  assert.equal((await app.inject(`/v1/tokens/4663/${known}/details?period=5Y`)).statusCode, 400);
  assert.equal((await app.inject("/v1/tokens/4663/not-an-address/details")).statusCode, 400);
  await app.close();
});
