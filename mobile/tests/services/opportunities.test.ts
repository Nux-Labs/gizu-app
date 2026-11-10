import { createOpportunityService } from "@/services/opportunities";
const row = {
  id: "1",
  name: "Pendle USDC",
  chainId: 1,
  vaultAddress: "0x55C1B6e461a6334B567bAF0FEb5D728715446f05",
  protocol: { id: "morpho", name: "Morpho" },
  status: "LIVE",
  totalApr: 6,
  tvl: 10,
};
const body = { list: [row], page: 0, items: 8, total: 1 };
const query = { search: "USDC & MON", page: 0, chainId: 1 };
const originalFetch = global.fetch;
const fetchMock = jest.fn();
beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => body });
});
test("featured Monad vaults remain visible and readable without admitting ordinary unsupported vaults", async () => {
  const own = {
    ...row,
    id: "configured:143:own",
    name: "Gizu Prime AUSD",
    chainId: 143,
    vaultAddress: "0x997D5064A7B48305c15C9D55AC2D94D7069Fc008",
    featured: true,
  };
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ...body, list: [own, { ...own, id: "not-featured", featured: false }] }),
  });
  const service = createOpportunityService("https://backend.example");
  const result = await service.list({ ...query, chainId: 143 }, new AbortController().signal);
  expect(result.list).toEqual([own]);
  const ownDetail = { ...detail, ...own, chain: { id: 143, name: "Monad" } };
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ opportunity: ownDetail }) });
  expect(await service.detail(own.id, new AbortController().signal)).toEqual(ownDetail);
});
afterEach(() => {
  global.fetch = originalFetch;
});
test("pins mainnet and encodes search with no signing or secret headers", async () => {
  expect(
    await createOpportunityService("http://localhost:3000/").list(
      query,
      new AbortController().signal,
    ),
  ).toEqual(body);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:3000/v1/opportunities?chainId=1&page=0&items=8&search=USDC%20%26%20MON",
    { signal: expect.anything() },
  );
  await createOpportunityService("http://localhost:3000").list(
    { ...query, protocol: "morpho" },
    new AbortController().signal,
  );
  expect(fetchMock.mock.calls[1][0]).toBe(
    "http://localhost:3000/v1/opportunities?chainId=1&page=0&items=8&search=USDC%20%26%20MON&protocol=morpho",
  );
});
test("passes catalog protocol facets through", async () => {
  const facets = { protocols: [{ id: "morpho", name: "Morpho", count: 1 }] };
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...body, facets }) });
  const result = await createOpportunityService("http://localhost:3000").list(
    query,
    new AbortController().signal,
  );
  expect(result.facets).toEqual(facets);
});
test.each([
  { ...body, list: [{ ...row, chainId: 10143 }] },
  { ...body, list: [{ ...row, totalApr: "6" }] },
  { ...body, list: [{ ...row, tvl: -1 }] },
  { ...body, list: [{ ...row, featured: "true" }] },
  { ...body, list: [row, row] },
  { ...body, total: -1 },
  { ...body, page: 1 },
  { ...body, items: 100 },
  { ...body, facets: { protocols: [{ id: "Bad id", name: "Bad", count: 1 }] } },
  { ...body, facets: { protocols: [{ id: "morpho", name: "Morpho", count: 0 }] } },
  {
    ...body,
    facets: {
      protocols: [
        { id: "morpho", name: "Morpho", count: 1 },
        { id: "morpho", name: "Morpho", count: 1 },
      ],
    },
  },
  null,
])("rejects malformed or wrong-network response %#", async (value) => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => value });
  await expect(
    createOpportunityService("http://localhost:3000").list(query, new AbortController().signal),
  ).rejects.toThrow("Invalid vault catalog response");
});
test("propagates cancellation to the request", async () => {
  const parent = new AbortController();
  let requestSignal: AbortSignal | undefined;
  fetchMock.mockImplementation(
    (_url, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        requestSignal = signal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const request = createOpportunityService("http://localhost:3000").list(query, parent.signal);
  parent.abort();
  await expect(request).rejects.toThrow("aborted");
  expect(requestSignal?.aborted).toBe(true);
});
test("HTTP failure is rejected and missing configuration makes no request", async () => {
  fetchMock.mockResolvedValue({ ok: false });
  await expect(
    createOpportunityService("http://localhost:3000").list(query, new AbortController().signal),
  ).rejects.toThrow("Vault catalog unavailable");
  fetchMock.mockClear();
  await expect(
    createOpportunityService("").list(query, new AbortController().signal),
  ).rejects.toThrow("not configured");
  expect(fetchMock).not.toHaveBeenCalled();
});
const detail = {
  ...row,
  apr: 4,
  chain: { id: 1, name: "Ethereum" },
  description: "Supply USDC.",
  action: "LEND",
  type: "AAVE_SUPPLY",
  dailyRewards: 10,
  liveCampaigns: 1,
  nativeApr: 2,
  explorerAddress: "0xabc",
  howToSteps: ["Supply"],
  depositUrl: "https://app.aave.com",
  identifier: "0xdef",
  tags: ["stable"],
  tokens: [{ id: "t", name: "USD Coin", symbol: "USDC", address: "0x1", decimals: 6, price: 1 }],
  campaigns: [
    {
      id: "c",
      campaignId: "0x2",
      type: "Incentive",
      apr: 1,
      dailyRewards: 5,
      startTimestamp: 1,
      endTimestamp: 2,
      creatorAddress: "0x3",
    },
  ],
};
test("detail reads one encoded mainnet opportunity", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ opportunity: detail }) });
  const service = createOpportunityService("http://localhost:3000/");
  expect(await service.detail("1", new AbortController().signal)).toEqual(detail);
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/v1/opportunities/1", {
    signal: expect.anything(),
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ opportunity: { ...detail, id: "a/b" } }),
  });
  await service.detail("a/b", new AbortController().signal);
  expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:3000/v1/opportunities/a%2Fb");
});
test.each([
  { opportunity: { ...detail, id: "2" } },
  { opportunity: { ...detail, chainId: 10143 } },
  { opportunity: { ...detail, apr: "4" } },
  { opportunity: { ...detail, featured: "true" } },
  { opportunity: { ...detail, tags: [1] } },
  { opportunity: { ...detail, tokens: [{ symbol: "USDC" }] } },
  { opportunity: { ...detail, campaigns: [{ ...detail.campaigns[0], apr: null }] } },
  { opportunity: { ...detail, chain: undefined } },
  detail,
  null,
])("detail rejects malformed or mismatched response %#", async (value) => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => value });
  await expect(
    createOpportunityService("http://localhost:3000").detail("1", new AbortController().signal),
  ).rejects.toThrow("Invalid vault response");
});
test("tvl records request the latest 30 and keep only totals", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ list: [{ total: 2, timestamp: 9 }, { total: 1 }] }),
  });
  expect(
    await createOpportunityService("http://localhost:3000").tvlRecords(
      "1",
      new AbortController().signal,
    ),
  ).toEqual([{ total: 2 }, { total: 1 }]);
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:3000/v1/opportunities/1/tvl-records?items=30",
    { signal: expect.anything() },
  );
});
test.each([
  { list: [{ total: "2" }] },
  { list: [{ total: -1 }] },
  { list: Array.from({ length: 31 }, () => ({ total: 1 })) },
  { list: null },
  null,
])("tvl records reject malformed response %#", async (value) => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => value });
  await expect(
    createOpportunityService("http://localhost:3000").tvlRecords("1", new AbortController().signal),
  ).rejects.toThrow("Invalid vault history response");
});
test("detail and history HTTP failures and missing configuration are rejected", async () => {
  fetchMock.mockResolvedValue({ ok: false });
  const service = createOpportunityService("http://localhost:3000");
  await expect(service.detail("1", new AbortController().signal)).rejects.toThrow(
    "Vault unavailable",
  );
  await expect(service.tvlRecords("1", new AbortController().signal)).rejects.toThrow(
    "Vault history unavailable",
  );
  fetchMock.mockClear();
  const unconfigured = createOpportunityService("");
  await expect(unconfigured.detail("1", new AbortController().signal)).rejects.toThrow(
    "not configured",
  );
  await expect(unconfigured.tvlRecords("1", new AbortController().signal)).rejects.toThrow(
    "not configured",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("uses the selected catalog chain and accepts unknown configured-vault metrics", async () => {
  const ethereum = {
    ...row,
    chainId: 1,
    vaultAddress: row.vaultAddress,
    totalApr: null,
    tvl: null,
  };
  const response = { ...body, list: [ethereum] };
  fetchMock.mockResolvedValue({ ok: true, json: async () => response });
  expect(
    await createOpportunityService("https://backend.example").list(
      { ...query, chainId: 1 },
      new AbortController().signal,
    ),
  ).toEqual(response);
  expect(fetchMock.mock.calls[0][0]).toContain("chainId=1");
});

test("loads environment-configured chains before accepting their detail responses", async () => {
  const service = createOpportunityService("https://backend.example");
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      list: [
        { id: 4663, name: "Robinhood" },
        { id: 143, name: "Monad" },
      ],
    }),
  });
  expect(await service.chains!(new AbortController().signal)).toEqual([
    { id: 4663, name: "Robinhood" },
    { id: 143, name: "Monad" },
  ]);
  expect(fetchMock.mock.calls[0][0]).toBe("https://backend.example/v1/chains");
  await expect(
    service.list({ ...query, chainId: 1 }, new AbortController().signal),
  ).rejects.toThrow("Chain is not available");
});

test.each(
  [
    [],
    [{ id: 143, name: "" }],
    [
      { id: 143, name: "Monad" },
      { id: 143, name: "Duplicate" },
    ],
    [{ id: 143, name: "Monad", explorerUrl: "http://unsafe" }],
  ].map((list) => [list]),
)("rejects malformed chain catalogs %j", async (list) => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ list }) });
  await expect(
    createOpportunityService("https://backend.example").chains!(new AbortController().signal),
  ).rejects.toThrow("Invalid chain catalog");
});

test("accepts verified USDC/USDG underlying metadata and rejects malformed assets", async () => {
  const asset = {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  };
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ...body, list: [{ ...row, asset }] }),
  });
  const service = createOpportunityService("https://backend.example");
  expect((await service.list(query, new AbortController().signal)).list[0]?.asset).toEqual(asset);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ...body, list: [{ ...row, asset: { ...asset, decimals: -1 } }] }),
  });
  await expect(service.list(query, new AbortController().signal)).rejects.toThrow(
    "Invalid vault catalog response",
  );
});

test("hides unsupported vaults from older catalog responses and drops their pagination", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      ...body,
      total: 123,
      list: [row, { ...row, id: "unsupported", vaultAddress: "0x" + "1".repeat(40) }],
    }),
  });
  expect(
    await createOpportunityService("https://backend.example").list(
      query,
      new AbortController().signal,
    ),
  ).toEqual({ ...body, list: [row], total: 1 });
});
test("chains without native profiles still check the backend for featured vaults and hide ordinary rows", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ...body, list: [{ ...row, chainId: 143 }] }),
  });
  expect(
    await createOpportunityService("https://backend.example").list(
      { ...query, chainId: 143 },
      new AbortController().signal,
    ),
  ).toEqual({ list: [], page: 0, items: 8, total: 0 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("featured pages retain the backend total instead of dropping remaining promotions", async () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({
    ...row,
    id: `featured-${i}`,
    featured: true,
  }));
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ...body, list: entries, total: 17 }),
  });
  const page = await createOpportunityService("https://backend.example").list(
    query,
    new AbortController().signal,
  );
  expect(page.total).toBe(17);
  expect(page.list).toHaveLength(8);
});
test("rejects unsupported direct vault links and changed deposit assets", async () => {
  const service = createOpportunityService("https://backend.example");
  for (const opportunity of [
    { ...detail, vaultAddress: "0x" + "1".repeat(40) },
    {
      ...detail,
      asset: { address: "0x" + "a".repeat(40), name: "USDC", symbol: "USDC", decimals: 6 },
    },
  ]) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ opportunity }) });
    await expect(service.detail("1", new AbortController().signal)).rejects.toThrow(
      "Deposits to this vault are not available",
    );
  }
});
