import { catalogCursor, readCatalogPage } from "@/features/opportunities/catalogPages";
import { mockOpportunityService, mainnetOpportunity } from "../support/opportunities";

test("one failed chain keeps the other chains visible and remains retryable", async () => {
  const service = mockOpportunityService();
  service.list.mockImplementation(async (query) => {
    if (query.chainId === 143) throw new Error("RPC unavailable");
    return {
      list: [{ ...mainnetOpportunity(1), chainId: query.chainId! }],
      total: 1,
      items: 8,
      page: 0,
    };
  });
  const result = await readCatalogPage(
    service,
    { search: "" },
    catalogCursor([
      { id: 143, name: "Monad" },
      { id: 4663, name: "Robinhood" },
    ]),
    new AbortController().signal,
  );
  expect(result.items.map((row) => row.chainId)).toEqual([4663]);
  expect(result.partial).toBe(true);
  expect(JSON.parse(result.nextCursor!)).toEqual([{ chainId: 143, page: 0 }]);
});

test("all chains failing reports an error instead of an empty catalog", async () => {
  const service = mockOpportunityService();
  service.list.mockRejectedValue(new Error("unavailable"));
  await expect(
    readCatalogPage(
      service,
      { search: "" },
      catalogCursor([{ id: 143, name: "Monad" }]),
      new AbortController().signal,
    ),
  ).rejects.toThrow("unavailable");
});
