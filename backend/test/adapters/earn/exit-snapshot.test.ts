import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import {
  EarnExitSnapshot,
  exitPrices,
} from "../../../src/adapters/earn/exit-snapshot.ts";
import type { ExitSnapshotProviders } from "../../../src/adapters/earn/exit-snapshot.ts";
import {
  monadUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
const now = Date.parse("2026-09-30T10:00:00Z"),
  owner = "0x1000000000000000000000000000000000000001",
  request = { profileId: "robinhood-usdg" as const, owner };
function prices() {
  return {
    tokens: [
      {
        assetId: robinhoodUsdgAssetId,
        blockchain: "hood",
        decimals: 6,
        contractAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        price: "1",
        priceUpdatedAt: new Date(now).toISOString(),
      },
      {
        assetId: monadUsdcAssetId,
        blockchain: "monad",
        decimals: 6,
        contractAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        price: "1",
        priceUpdatedAt: new Date(now).toISOString(),
      },
      {
        assetId: "nep141:eth.omft.near",
        blockchain: "eth",
        decimals: 18,
        symbol: "ETH",
        price: "3000",
        priceUpdatedAt: new Date(now).toISOString(),
      },
    ],
  };
}
function providers(
  patch: Partial<ExitSnapshotProviders> = {},
): ExitSnapshotProviders {
  return {
    read: async () => ({
      chainId: 4663,
      owner,
      block: {
        number: 100n,
        hash: ("0x" + "11".repeat(32)) as `0x${string}`,
        timestamp: BigInt(now / 1000),
      },
      token: 100000n,
      native: 0n,
      wrapped: 0n,
      shares: 0n,
      shareDecimals: 18,
    }),
    prices: async () => prices(),
    canonical: async () => {},
    ...patch,
  };
}
test("snapshot includes only the investment wallet and never attests private completion", async () => {
  const p = await new EarnExitSnapshot({}, providers(), () => now).read(
    request,
  );
  assert.equal(p.owner, owner);
  assert.deepEqual(p.balances, {
    tokenAtoms: "100000",
    nativeWei: "0",
    wrappedWei: "0",
    shares: "0",
  });
  assert.equal(p.prices.ethUsd18, null);
  assert.equal(p.residualUsdcAtoms, "100000");
  assert.equal(p.publicResidualReady, true);
  assert.equal(p.completionAttested, false);
  assert.equal(p.readOnly, true);
  assert.equal(p.walletScope, "investment-only-hold-wallet-excluded");
});
test("strict dust boundary, explicit wrapped ETH and remaining shares cannot look complete", async () => {
  for (const [token, wrapped, shares] of [
    [500000n, 0n, 0n],
    [499999n, 1n, 0n],
    [1n, 0n, 1n],
  ]) {
    const mock = providers();
    const original = await mock.read(request);
    mock.read = async () => ({
      ...original,
      token: token!,
      wrapped: wrapped!,
      shares: shares!,
    });
    const p = await new EarnExitSnapshot({}, mock, () => now).read(request);
    assert.equal(p.publicResidualReady, false);
  }
});
test("fresh exact USDC denominator is used, and stale/changed/duplicate metadata is rejected", () => {
  const p = prices();
  p.tokens[1]!.price = "0.999999";
  assert.equal(
    exitPrices(p, "robinhood-usdg", false, now).usdcUsd18,
    "999999000000000000",
  );
  for (const changed of [
    prices().tokens.map((t) => ({
      ...t,
      priceUpdatedAt: new Date(now - 300001).toISOString(),
    })),
    [...prices().tokens, prices().tokens[0]!],
    prices().tokens.map((t) => ({ ...t, contractAddress: owner })),
  ])
    assert.throws(() =>
      exitPrices({ tokens: changed }, "robinhood-usdg", false, now),
    );
  // No ETH price is needed when both ETH representations are explicitly zero.
  assert.equal(
    exitPrices(
      { tokens: prices().tokens.slice(0, 2) },
      "robinhood-usdg",
      false,
      now,
    ).ethUsd18,
    null,
  );
  assert.throws(() =>
    exitPrices(
      { tokens: prices().tokens.slice(0, 2) },
      "robinhood-usdg",
      true,
      now,
    ),
  );
});
test("changed chain, stale reference or reorg fails closed without exposing provider credentials", async () => {
  for (const patch of [
    {
      read: async () => ({
        ...(await providers().read(request)),
        chainId: 1 as const,
      }),
    },
    {
      read: async () => ({
        ...(await providers().read(request)),
        block: {
          number: 100n,
          hash: ("0x" + "11".repeat(32)) as `0x${string}`,
          timestamp: BigInt(((now - 60001) / 1000) | 0),
        },
      }),
    },
    {
      canonical: async () => {
        throw new Error("secret-provider-key");
      },
    },
  ]) {
    await assert.rejects(
      new EarnExitSnapshot({}, providers(patch), () => now).read(request),
      (error) => !String(error).includes("secret-provider-key"),
    );
  }
});

test("observed production 67-second prices remain usable without extending chain freshness", async () => {
  const price = prices();
  price.tokens = price.tokens.map((t) => ({
    ...t,
    priceUpdatedAt: new Date(now - 67000).toISOString(),
  }));
  const p = await new EarnExitSnapshot(
    {},
    providers({ prices: async () => price }),
    () => now,
  ).read(request);
  assert.equal(p.priceMaxAgeMs, 300000);
  assert.equal(p.prices.observedAtMs, now - 67000);
  assert.equal(
    p.prices.tokenPriceUpdatedAt,
    new Date(now - 67000).toISOString(),
  );
  assert.equal(p.expiresAtMs, now + 60000);
  for (const age of [300001])
    await assert.rejects(
      new EarnExitSnapshot(
        {},
        providers({
          prices: async () => ({
            tokens: prices().tokens.map((t) => ({
              ...t,
              priceUpdatedAt: new Date(now - age).toISOString(),
            })),
          }),
        }),
        () => now,
      ).read(request),
    );
});

test("captured credential-free production metadata and actual67second timestamp qualify under five-minute exit valuation", async () => {
  const registry = JSON.parse(
    await readFile(
      new URL("../../fixtures/earn-exit-tokens-public.json", import.meta.url),
      "utf8",
    ),
  );
  const observed = Date.parse(registry.responseDate),
    base = await providers().read(request),
    mock = providers({
      read: async () => ({
        ...base,
        block: { ...base.block, timestamp: BigInt(observed / 1000) },
      }),
      prices: async () => registry,
    });
  const snapshot = await new EarnExitSnapshot({}, mock, () => observed).read(
    request,
  );
  assert.equal(snapshot.prices.tokenPriceUpdatedAt, "2026-09-30T13:07:30.472Z");
  assert.equal(snapshot.prices.usdcUsd18, "999818000000000000");
  assert.equal(snapshot.residualUsdcAtoms, "100019");
  assert.equal(snapshot.priceMaxAgeMs, 300000);
  assert.equal(snapshot.expiresAtMs, observed + 60000);
  assert.equal(
    exitPrices(registry, "ethereum-usdc", true, observed).ethUsd18,
    "2730030000000000000000",
  );
});

test("failed price validation retains asset and age diagnostics without prices or wallet data", async () => {
  const raw = prices();
  raw.tokens[0]!.priceUpdatedAt = new Date(now - 300001).toISOString();
  await assert.rejects(
    new EarnExitSnapshot(
      {},
      providers({ prices: async () => raw }),
      () => now,
    ).read(request),
    (error: any) => {
      assert.deepEqual(error.diagnostic, {
        stage: "prices-validate",
        reason: "price-expired",
        asset: "token",
        priceAgeMs: 300001,
        priceMaxAgeMs: 300000,
      });
      assert.equal(
        error.message,
        "Fresh investment-wallet exit snapshot unavailable",
      );
      assert.ok(!JSON.stringify(error).includes(owner));
      return true;
    },
  );
});

test("failures distinguish chain, reference, price fetch and canonical stages using safe cause codes", async () => {
  const upstream = new TypeError("private-provider-url-and-key", {
    cause: Object.assign(new Error("private-certificate-details"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
  });
  for (const [patch, want] of [
    [
      {
        read: async () => {
          throw upstream;
        },
      },
      {
        stage: "chain-read",
        reason: "unclassified",
        errorType: "TypeError",
        transportCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
    ],
    [
      {
        read: async () => ({
          ...(await providers().read(request)),
          chainId: 1,
        }),
      },
      { stage: "reference-validate", reason: "invalid-reference" },
    ],
    [
      {
        prices: async () => {
          throw upstream;
        },
      },
      {
        stage: "prices-fetch",
        reason: "unclassified",
        errorType: "TypeError",
        transportCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
    ],
    [
      {
        canonical: async () => {
          throw Object.assign(new Error("private-rpc-response"), {
            status: 429,
            code: -32005,
          });
        },
      },
      {
        stage: "canonical-check",
        reason: "provider-throttled",
        httpStatus: 429,
        rpcCode: -32005,
      },
    ],
    [
      {
        read: async () => {
          throw Object.assign(new Error("private-throttle-response"), {
            code: 429,
          });
        },
      },
      { stage: "chain-read", reason: "provider-throttled", rpcCode: 429 },
    ],
  ] as const) {
    await assert.rejects(
      new EarnExitSnapshot({}, providers(patch), () => now).read(request),
      (error: any) => {
        assert.deepEqual(error.diagnostic, want);
        assert.ok(!JSON.stringify(error).includes("private-"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});
