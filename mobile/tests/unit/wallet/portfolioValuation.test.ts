import {
  createPortfolioValuationService,
  expirePortfolioValuation,
} from "@/services/wallet/portfolioValuation";
import { portfolioValue } from "@/domain/wallet/portfolioValue";
import { earnProfiles } from "@/domain/earn/types";
import type { MainnetPortfolioSnapshot, OwnedPortfolioAsset } from "@/domain/wallet/storedSigner";
import { mainnetPortfolio } from "../../support/mainnetWallet";
import { exitSnapshot } from "../../support/exitCompletion";

const now = 1000000;
const owner = "0x" + "1".repeat(40);
const profile = earnProfiles["robinhood-usdg"];
function asset(overrides: Partial<OwnedPortfolioAsset> = {}): OwnedPortfolioAsset {
  return {
    assetId: "usdg",
    chainId: 4663,
    token: profile.token,
    symbol: "USDG",
    decimals: 6,
    balanceAtoms: "1000001",
    observedAtoms: "1000001",
    complete: true,
    stale: false,
    checkedAt: now,
    valueUsdcAtoms: null,
    valuationUnavailable: true,
    ...overrides,
  };
}
function native(): MainnetPortfolioSnapshot {
  return {
    ...mainnetPortfolio("wallet", owner, "1000000"),
    checkedAt: now,
    valuationComplete: false,
    ownedAssets: [asset()],
    positions: [
      {
        ...asset({ token: profile.vault }),
        shareAtoms: "9999999999999999999",
        underlyingAtoms: "3000001",
        conversionEstimated: true,
      },
    ],
  };
}
function prices() {
  const raw = exitSnapshot(now);
  raw.owner = owner;
  raw.prices.tokenUsd18 = "900000000000000000";
  raw.prices.tokenPriceUpdatedAt = new Date(now - 1000).toISOString();
  raw.prices.observedAtMs = now - 1000;
  // Residual describes the transient lookup address, never the owned vault amount.
  raw.residualUsdcAtoms = "999999999";
  return raw;
}
function mockFetch(raw: unknown = prices()) {
  return jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue({ ok: true, json: async () => raw } as Response);
}
const signal = () => new AbortController().signal;

test("prices native owned USDG and vault underlying exactly, using only one address-bound read", async () => {
  const fetcher = mockFetch();
  const source = native();
  const value = await createPortfolioValuationService(
    "https://backend.test/",
    fetcher,
    () => now,
  ).value(source, signal());
  expect(value.ownedAssets?.[0]?.valueUsdcAtoms).toBe("900000");
  expect(value.positions?.[0]?.valueUsdcAtoms).toBe("2700000");
  expect(value.positions?.[0]?.checkedAt).toBe(999000);
  expect(value.valuationComplete).toBe(true);
  expect(value.valuationExpiresAt).toBe(now + 30000);
  expect(value.totalAtoms).toBe("1000000");
  expect(source.positions?.[0]?.valueUsdcAtoms).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://backend.test/v1/earn/exit-snapshot",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ profileId: "robinhood-usdg", owner }),
    }),
  );
});

test("expiry removes prices without erasing the owned token or vault underlying amounts", async () => {
  const value = await createPortfolioValuationService(
    "https://backend.test",
    mockFetch(),
    () => now,
  ).value(native(), signal());
  const expired = expirePortfolioValuation(value);
  expect(expired.valuationExpiresAt).toBeUndefined();
  expect(expired.ownedAssets?.[0]?.valueUsdcAtoms).toBeNull();
  expect(expired.positions?.[0]?.valueUsdcAtoms).toBeNull();
  expect(expired.positions?.[0]?.underlyingAtoms).toBe("3000001");
  expect(expired.valuationComplete).toBe(false);
  expect(expired.totalAtoms).toBe("1000000");
});

test("cache shares only verified profile prices across owners until response expiry", async () => {
  let clock = now;
  const fetcher = mockFetch();
  const service = createPortfolioValuationService("https://backend.test", fetcher, () => clock);
  await service.value(native(), signal());
  const second = { ...native(), fundingAddress: "0x" + "2".repeat(40) };
  expect((await service.value(second, signal())).ownedAssets?.[0]?.valueUsdcAtoms).toBe("900000");
  expect(fetcher).toHaveBeenCalledTimes(1);
  clock += 60001;
  fetcher.mockResolvedValueOnce({ ok: false } as Response);
  const expired = await service.value(
    { ...native(), ownedAssets: [asset({ checkedAt: clock })], positions: [] },
    signal(),
  );
  expect(expired.ownedAssets?.[0]?.valueUsdcAtoms).toBeNull();
  expect(expired.valuationComplete).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([
  [
    "owner",
    (r: ReturnType<typeof prices>) => {
      r.owner = "0x" + "2".repeat(40);
    },
  ],
  [
    "chain",
    (r: ReturnType<typeof prices>) => {
      r.chainId = 1;
    },
  ],
  [
    "token",
    (r: ReturnType<typeof prices>) => {
      r.token = profile.vault;
    },
  ],
  [
    "vault",
    (r: ReturnType<typeof prices>) => {
      r.vault = profile.token;
    },
  ],
  [
    "profile",
    (r: ReturnType<typeof prices>) => {
      r.profileId = "ethereum-usdc";
    },
  ],
  [
    "read-only",
    (r: ReturnType<typeof prices>) => {
      r.readOnly = false;
    },
  ],
  [
    "zero token price",
    (r: ReturnType<typeof prices>) => {
      r.prices.tokenUsd18 = "0";
    },
  ],
  [
    "zero denominator",
    (r: ReturnType<typeof prices>) => {
      r.prices.usdcUsd18 = "0";
    },
  ],
  [
    "uint256 overflow",
    (r: ReturnType<typeof prices>) => {
      r.prices.tokenUsd18 = (1n << 256n).toString();
    },
  ],
  [
    "stale price",
    (r: ReturnType<typeof prices>) => {
      r.prices.tokenPriceUpdatedAt = new Date(now - 300001).toISOString();
    },
  ],
  [
    "future price",
    (r: ReturnType<typeof prices>) => {
      r.prices.tokenPriceUpdatedAt = new Date(now + 5001).toISOString();
    },
  ],
  [
    "observation mismatch",
    (r: ReturnType<typeof prices>) => {
      r.prices.observedAtMs = now;
    },
  ],
  [
    "expired",
    (r: ReturnType<typeof prices>) => {
      r.expiresAtMs = now;
    },
  ],
  [
    "extended expiry",
    (r: ReturnType<typeof prices>) => {
      r.expiresAtMs = now + 60001;
    },
  ],
] as const)("rejects %s price evidence while retaining raw balances", async (_, corrupt) => {
  const raw = prices();
  corrupt(raw);
  const result = await createPortfolioValuationService(
    "https://backend.test",
    mockFetch(raw),
    () => now,
  ).value(native(), signal());
  expect(result.ownedAssets?.[0]).toMatchObject({ observedAtoms: "1000001", valueUsdcAtoms: null });
  expect(result.positions?.[0]?.underlyingAtoms).toBe("3000001");
  expect(result.valuationComplete).toBe(false);
});

test("stale or incomplete observations never acquire a fresh verified price", async () => {
  const snapshot = native();
  snapshot.ownedAssets = [
    asset({ stale: true }),
    asset({ token: profile.token.toUpperCase(), complete: false, balanceAtoms: null }),
  ];
  snapshot.positions![0]!.stale = true;
  const result = await createPortfolioValuationService(
    "https://backend.test",
    mockFetch(),
    () => now,
  ).value(snapshot, signal());
  expect(result.ownedAssets?.every((row) => row.valueUsdcAtoms === null)).toBe(true);
  expect(result.positions?.[0]?.valueUsdcAtoms).toBeNull();
  expect(result.valuationComplete).toBe(false);
});

test("zero USDG needs no price and unsupported tokens remain unpriced", async () => {
  const fetcher = mockFetch();
  const service = createPortfolioValuationService("https://backend.test", fetcher, () => now);
  const result = await service.value(
    { ...native(), ownedAssets: [asset({ balanceAtoms: "0", observedAtoms: "0" })], positions: [] },
    signal(),
  );
  expect(result.valuationComplete).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  const unknown = await service.value(
    { ...native(), ownedAssets: [asset({ token: "0x" + "f".repeat(40) })], positions: [] },
    signal(),
  );
  expect(unknown.valuationComplete).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

test("large integer pricing floors exactly and uses the actual USDC denominator", async () => {
  const raw = prices();
  raw.prices.tokenUsd18 = "2000000000000000000";
  raw.prices.usdcUsd18 = "3000000000000000000";
  const result = await createPortfolioValuationService(
    "https://backend.test",
    mockFetch(raw),
    () => now,
  ).value(
    {
      ...native(),
      positions: [],
      ownedAssets: [
        asset({ balanceAtoms: "9007199254740993000001", observedAtoms: "9007199254740993000001" }),
      ],
    },
    signal(),
  );
  expect(result.ownedAssets?.[0]?.valueUsdcAtoms).toBe("6004799503160662000000");
  expect(portfolioValue(result).totalAtoms).toBe("6004799503160663000000");
});

test("abort cancels a pending lookup even if the fetch implementation ignores its signal", async () => {
  const controller = new AbortController();
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(() => new Promise(() => {}));
  const pending = createPortfolioValuationService("https://backend.test", fetcher, () => now).value(
    native(),
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    createPortfolioValuationService("https://backend.test", fetcher, () => now).value(
      native(),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("20 second timeout returns the partial native snapshot", async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() => new Promise(() => {}));
    const pending = createPortfolioValuationService(
      "https://backend.test",
      fetcher,
      () => now,
    ).value(native(), signal());
    await jest.advanceTimersByTimeAsync(20000);
    expect((await pending).valuationComplete).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});
