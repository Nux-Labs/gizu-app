import {
  supportedFundingNetworks,
  fundingCapabilityService,
} from "@/services/wallet/fundingCapabilities";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";
jest.mock("@/services/wallet/nativeBridge", () => ({ getSignerCapabilities: jest.fn() }));

const capabilities = (fundingChainIds: number[]) => ({
  fundingContractVersion: 2,
  fundingChainIds,
});
let epoch = 2000000000000;
beforeEach(() => {
  epoch += 31000;
  jest.spyOn(Date, "now").mockReturnValue(epoch);
  jest.mocked(getSignerCapabilities).mockResolvedValue({
    contractVersion: 1,
    available: true,
    walletStorage: true,
    backup: true,
    transfers: true,
    swaps: true,
    fundingContractVersion: 2,
    fundingChainIds: [143, 8453, 42161],
  });
});
afterEach(() => jest.restoreAllMocks());
test("funding choices require the native and backend intersection", () => {
  expect(
    supportedFundingNetworks(capabilities([143, 8453, 42161]), capabilities([143, 42161])).map(
      (network) => network.chainId,
    ),
  ).toEqual([143, 42161]);
});
test("old hosts and absent backend capability remain Monad only", () => {
  expect(
    supportedFundingNetworks({}, capabilities([143, 8453, 42161])).map(
      (network) => network.chainId,
    ),
  ).toEqual([143]);
  expect(
    supportedFundingNetworks(capabilities([143, 8453, 42161]), {}).map(
      (network) => network.chainId,
    ),
  ).toEqual([143]);
});
test("unqualified and disjoint networks cannot appear as deposit choices", () => {
  expect(supportedFundingNetworks(capabilities([8453]), capabilities([42161]))).toEqual([]);
  expect(supportedFundingNetworks(capabilities([143, 1, 8453]), capabilities([143, 1]))).toEqual(
    [],
  );
});

test("only an absent legacy capability endpoint defaults to Monad", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ status: 404, ok: false } as Response);
  expect((await fundingCapabilityService.networks()).map((network) => network.chainId)).toEqual([
    143,
  ]);
});
test("a failed capability endpoint does not guess that networks are enabled", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ status: 503, ok: false } as Response);
  await expect(fundingCapabilityService.networks()).rejects.toThrow();
});

test("deposit networks and Ethereum admission share one fresh backend capability read", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      fundingContractVersion: 2,
      fundingChainIds: [143, 8453],
      earnPrivateFundingVersion: 2,
      earnPrivateFundingProfileChainIds: [1],
    }),
  } as Response);
  await fundingCapabilityService.networks();
  expect(await fundingCapabilityService.ethereumPrivateFundingAvailable()).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
