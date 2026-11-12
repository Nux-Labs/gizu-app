import { createTokenCatalogService } from "@/services/tokenCatalog";
import { tokenIdentity, type TokenQuery } from "@/domain/tokenCatalog";
import { catalogPage, catalogToken } from "../support/tokenCatalog";
const query: TokenQuery = { chainId: 4663, category: "rwa", search: "", page: 0 };
const service = createTokenCatalogService("https://api.example.com/");
const originalFetch = global.fetch;
function response(body: unknown = catalogPage) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
}
beforeEach(() => response());
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});
test("sends all five parameters with encoded search and returns a validated page", async () => {
  expect(await service.list({ ...query, search: "A & B/#" }, new AbortController().signal)).toEqual(
    catalogPage,
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.com/v1/tokens?chainId=4663&category=rwa&search=A%20%26%20B%2F%23&page=0&items=20",
    { signal: expect.anything() },
  );
});
test("asks the gateway to hide illiquid stocks only when the query says so", async () => {
  await service.list({ ...query, liquidOnly: true }, new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.com/v1/tokens?chainId=4663&category=rwa&search=&page=0&items=20&liquidOnly=true",
    { signal: expect.anything() },
  );
});
test.each([
  null,
  {},
  { ...catalogPage, page: 1 },
  { ...catalogPage, items: 60 },
  { ...catalogPage, total: -1 },
  { ...catalogPage, total: 1.5 },
  { ...catalogPage, total: 0 },
  ...[
    { chainId: 1 },
    { address: "wrong" },
    { decimals: -1 },
    { decimals: 1.2 },
    { logoURI: 7 },
    { symbol: null },
    { name: null },
    { issuer: "unknown" },
    { category: "other" },
    { swapListed: "yes" },
    { fusionStatus: "available" },
  ].map((patch) => ({ ...catalogPage, list: [{ ...catalogToken, ...patch }] })),
  {
    ...catalogPage,
    total: 2,
    list: [
      catalogToken,
      { ...catalogToken, address: catalogToken.address.toUpperCase().replace("0X", "0x") },
    ],
  },
])("rejects malformed or mismatched response %#", async (body) => {
  response(body);
  await expect(service.list(query, new AbortController().signal)).rejects.toThrow(
    "Invalid token catalog",
  );
});
test("accepts empty pages and unlisted non-RWA tokens; identity includes address and chain", async () => {
  response({ list: [], page: 2, items: 20, total: 0 });
  await expect(
    service.list({ ...query, page: 2 }, new AbortController().signal),
  ).resolves.toMatchObject({ list: [] });
  response({
    ...catalogPage,
    list: [{ ...catalogToken, category: "other", issuer: null, logoURI: null, swapListed: false }],
  });
  await expect(
    service.list({ ...query, category: "all" }, new AbortController().signal),
  ).resolves.toMatchObject({ total: 1 });
  expect(tokenIdentity({ chainId: 1, address: "0xAB" })).toBe("1:0xab");
  expect(tokenIdentity({ ...catalogToken, chainId: 1 })).not.toBe(tokenIdentity(catalogToken));
});
test.each([404, 503, 500])("reports HTTP %s as unavailable", async (status) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status });
  await expect(service.list(query, new AbortController().signal)).rejects.toThrow("unavailable");
});
test("rejects missing configuration and invalid JSON", async () => {
  await expect(
    createTokenCatalogService("").list(query, new AbortController().signal),
  ).rejects.toThrow("not configured");
  expect(fetch).not.toHaveBeenCalled();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => {
      throw new Error("JSON");
    },
  });
  await expect(service.list(query, new AbortController().signal)).rejects.toThrow("JSON");
});
function pendingFetch() {
  global.fetch = jest.fn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        else signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
}
test("times out at 12 seconds", async () => {
  jest.useFakeTimers();
  pendingFetch();
  const result = expect(service.list(query, new AbortController().signal)).rejects.toThrow(
    "aborted",
  );
  await jest.advanceTimersByTimeAsync(12000);
  await result;
  expect(jest.getTimerCount()).toBe(0);
});
test.each([true, false])("forwards caller cancellation (already aborted: %s)", async (before) => {
  pendingFetch();
  const controller = new AbortController();
  if (before) controller.abort();
  const result = expect(service.list(query, controller.signal)).rejects.toThrow("aborted");
  controller.abort();
  await result;
});
test("omits chainId to browse every network and validates DeFi categories", async () => {
  const defi = { ...catalogToken, chainId: 1 as const, category: "other" as const, issuer: null };
  response({ ...catalogPage, list: [defi] });
  const all = { ...query, chainId: null, category: "other" as const };
  expect(await service.list(all, new AbortController().signal)).toEqual({
    ...catalogPage,
    list: [defi],
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://api.example.com/v1/tokens?category=other&search=&page=0&items=20",
    { signal: expect.anything() },
  );
  response({ ...catalogPage, list: [catalogToken] });
  await expect(service.list(all, new AbortController().signal)).rejects.toThrow(
    "Invalid token catalog",
  );
});
