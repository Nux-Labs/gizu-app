import { createTokenDetailsService } from "@/services/tokenDetails";
import { tokenDetails } from "../support/tokenDetails";

const service = createTokenDetailsService("https://api.example.com/");
const originalFetch = global.fetch;
function respond(body: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({ ok, json: async () => body });
}
afterEach(() => {
  global.fetch = originalFetch;
});
const signal = () => new AbortController().signal;

test("requests one token's details for a period and returns the validated page", async () => {
  respond(tokenDetails);
  await expect(service.details(tokenDetails.address, "1M", signal())).resolves.toEqual(
    tokenDetails,
  );
  expect(fetch).toHaveBeenCalledWith(
    `https://api.example.com/v1/tokens/4663/${tokenDetails.address}/details?period=1M`,
    { signal: expect.anything() },
  );
});

test("accepts a page without price, chart, ISIN or share ratio", async () => {
  const sparse = { ...tokenDetails, priceUsd: null, chart: null, isin: null, sharesPerToken: null };
  respond(sparse);
  await expect(service.details(tokenDetails.address, "1M", signal())).resolves.toEqual(sparse);
});

test.each([
  ["another token", { address: "0x" + "c".repeat(40) }],
  ["an unknown kind", { kind: "bond" }],
  ["another period", { chart: { ...tokenDetails.chart, period: "1W" } }],
  ["a single point", { chart: { period: "1M", points: [{ time: 1, price: 1 }] } }],
  [
    "points out of order",
    {
      chart: {
        period: "1M",
        points: [
          { time: 2, price: 1 },
          { time: 1, price: 1 },
        ],
      },
    },
  ],
  ["a zero price", { priceUsd: 0 }],
  ["a malformed share ratio", { sharesPerToken: "1e3" }],
  ["missing sessions", { sessions: undefined }],
])("rejects a page with %s", async (_, patch) => {
  respond({ ...tokenDetails, ...patch });
  await expect(service.details(tokenDetails.address, "1M", signal())).rejects.toThrow(
    "Token details unavailable.",
  );
});

test("rejects bad input and failed responses without leaking provider details", async () => {
  respond(tokenDetails);
  await expect(service.details("not-an-address", "1M", signal())).rejects.toThrow("unavailable");
  expect(fetch).not.toHaveBeenCalled();
  respond({ message: "provider secret" }, false);
  await expect(service.details(tokenDetails.address, "1M", signal())).rejects.toThrow(
    "Token details unavailable.",
  );
  await expect(
    createTokenDetailsService("").details(tokenDetails.address, "1M", signal()),
  ).rejects.toThrow("not configured");
});
