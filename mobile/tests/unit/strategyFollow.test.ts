import * as SecureStore from "expo-secure-store";
import { vaultChanges, type SealedAssetView, type StrategyDetail } from "@/domain/strategies";
import { behindText, copyPlan, signalAssetInfo } from "@/domain/strategyCopy";
import type { MainnetPortfolioSnapshot } from "@/domain/wallet/storedSigner";
import { createStrategyService } from "@/services/strategies";
import { createMemoryFollowStore, secureFollowStore } from "@/services/strategyFollows";
import {
  enableStrategyPush,
  followStrategyPush,
  strategyForPushRef,
} from "@/services/strategyPush";
import { mainnetPortfolio } from "../support/mainnetWallet";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const word = (digit: string) => `0x${digit.repeat(64)}`;
const asset = (
  chainId: number,
  kind: 0 | 1,
  address: string,
  weightBps: number,
): SealedAssetView => ({
  chainId,
  kind,
  address,
  weightBps,
  assetId: word(String((weightBps / 500) % 10)),
});
const basket = [
  asset(8453, 0, NVDA, 5000),
  asset(4663, 1, VAULT, 2500),
  asset(8453, 0, USDC, 2500),
];
const row = {
  complete: true,
  stale: false,
  checkedAt: 1,
  valueUsdcAtoms: null,
  valuationUnavailable: false,
};
function holding(valueAtoms: string): MainnetPortfolioSnapshot {
  return {
    ...mainnetPortfolio("w", "0x1111111111111111111111111111111111111111", "0"),
    ownedAssets: [
      {
        ...row,
        assetId: "nvda",
        chainId: 8453,
        token: NVDA,
        symbol: "NVDAc",
        decimals: 18,
        balanceAtoms: "1",
        observedAtoms: "1",
        valueUsdAtoms: valueAtoms,
      },
    ],
  } as unknown as MainnetPortfolioSnapshot;
}

test("sealed assets resolve to Gizu's universe and anything else is never traded", () => {
  expect(signalAssetInfo(asset(8453, 0, NVDA.toLowerCase(), 1))).toMatchObject({
    kind: "stock",
    symbol: "NVDAc",
    label: "NVDAc on Base",
  });
  expect(signalAssetInfo(asset(4663, 1, VAULT, 1))).toMatchObject({
    kind: "vault",
    profileId: "robinhood-usdg",
  });
  expect(signalAssetInfo(asset(8453, 0, USDC, 1))).toEqual({ kind: "cash", label: "USDC" });
  expect(signalAssetInfo(asset(8453, 0, "0x000000000000000000000000000000000000dEaD", 1))).toEqual({
    kind: "unknown",
    label: "0x0000…dEaD",
  });
});

test("a first copy splits the budget by weight: buys, a vault deposit, and USDC kept", () => {
  const plan = copyPlan(basket, 100_000_000n, null);
  expect(plan.legs).toEqual([
    expect.objectContaining({ kind: "stock", symbol: "NVDAc", atoms: 50_000_000n }),
    expect.objectContaining({
      kind: "vault",
      profileId: "robinhood-usdg",
      atoms: 25_000_000n,
      small: true,
    }),
    expect.objectContaining({ kind: "cash", atoms: 25_000_000n }),
  ]);
  expect(plan.overweight).toEqual([]);
  // A large deposit is not flagged.
  expect(copyPlan(basket, 1_000_000_000n, null).legs[1]).toMatchObject({ small: false });
});

test("an update buys only the difference, and positions above target are pointed out, not sold", () => {
  // Already holding $40 of NVDA; $60 more makes $100, so NVDA's 50% target is $50: buy $10.
  const plan = copyPlan(basket, 60_000_000n, holding("40000000"));
  expect(plan.legs[0]).toMatchObject({ symbol: "NVDAc", atoms: 10_000_000n });
  expect(plan.legs[1]).toMatchObject({ kind: "vault", atoms: 25_000_000n });
  expect(plan.legs[2]).toMatchObject({ kind: "cash", atoms: 25_000_000n });

  // Holding $90 of NVDA with $10 more: NVDA is $40 over its $50 target. Buys scale to the budget.
  const heavy = copyPlan(basket, 10_000_000n, holding("90000000"));
  expect(heavy.overweight).toEqual([
    expect.objectContaining({ symbol: "NVDAc", address: NVDA, excessAtoms: 40_000_000n }),
  ]);
  const spent = heavy.legs.reduce((sum, leg) => sum + leg.atoms, 0n);
  expect(spent).toBe(10_000_000n);
  expect(heavy.legs.find((leg) => leg.kind === "stock")).toBeUndefined();
});

test("tiny buys and unknown assets stay in USDC", () => {
  const plan = copyPlan([asset(8453, 0, NVDA, 9500), asset(8453, 0, AAPL, 500)], 10_000_000n, null);
  // AAPL's 5% of $10 is $0.50, below the $1 minimum.
  expect(plan.legs.map((leg) => [leg.kind, leg.atoms])).toEqual([
    ["stock", 9_500_000n],
    ["cash", 500_000n],
  ]);
  const unknown = copyPlan(
    [
      asset(8453, 0, NVDA, 5000),
      asset(8453, 0, "0x000000000000000000000000000000000000dEaD", 5000),
    ],
    10_000_000n,
    null,
  );
  expect(unknown.unsupported).toEqual(["0x0000…dEaD"]);
  expect(unknown.legs.at(-1)).toMatchObject({ kind: "cash", atoms: 5_000_000n });
});

test("behind text and vault change counts", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  expect(behindText("2026-11-23T11:30:00Z", now)).toBe("30 minutes");
  expect(behindText("2026-11-23T09:00:00Z", now)).toBe("3 hours");
  expect(behindText("2026-11-20T12:00:00Z", now)).toBe("3 days");
  const entry = (seq: number, vaultBps: number, revealed = true) => ({
    seq,
    committedAt: null,
    revealedAt: revealed ? "2026-11-20T00:00:00Z" : null,
    commitTx: null,
    revealTx: null,
    assets: [asset(4663, 1, VAULT, vaultBps), asset(8453, 0, USDC, 10_000 - vaultBps)],
    periodReturnBps: null,
    likes: 0,
    comments: 0,
    liked: false,
  });
  const history: StrategyDetail["history"] = [
    entry(0, 2500),
    entry(1, 2500),
    entry(2, 5000),
    entry(3, 0, false),
  ];
  expect(vaultChanges(history)).toBe(1);
});

test("notification references match the API and map back only to followed strategies", () => {
  // Value computed by backend pushRef("6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f", 7).
  const device = "6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f";
  expect(strategyForPushRef("7b02db34df72e3ec1deb9beaf3cbe044", device, [3, 7])).toBe(7);
  expect(strategyForPushRef("7b02db34df72e3ec1deb9beaf3cbe044", device, [3])).toBeNull();
});

test("enabling notifications registers once and follows every strategy; a forgotten device re-registers", async () => {
  const store = createMemoryFollowStore([
    { strategyId: 3, name: "A", subscriberKey: word("a"), expiresAt: "", copiedSeq: null },
  ]);
  const api = {
    register: jest.fn(async () => "6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f"),
    follow: jest.fn(async () => true),
    remove: jest.fn(),
  };
  const platform = { token: jest.fn(async () => "fcm-token-0123456789") };
  expect(await enableStrategyPush({ api, platform, store }, [3], true)).toBe("enabled");
  expect(platform.token).toHaveBeenCalledWith({ prompt: true });
  expect(api.register).toHaveBeenCalledWith("fcm-token-0123456789", "ios");
  expect(await store.pushDevice()).toBe("6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f");

  // The backend dropped the device: following again registers and re-follows everything.
  api.follow.mockResolvedValueOnce(false);
  expect(await followStrategyPush({ api, platform, store }, 9)).toBe("enabled");
  expect(api.register).toHaveBeenCalledTimes(2);
  expect(api.follow.mock.calls.slice(-2)).toEqual([
    ["6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f", 3],
    ["6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f", 9],
  ]);

  const denied = { token: jest.fn(async () => "denied" as const) };
  expect(await enableStrategyPush({ api, platform: denied, store }, [3], true)).toBe("denied");
  const none = { token: jest.fn(async () => null) };
  expect(await enableStrategyPush({ api, platform: none, store }, [3], true)).toBe("unavailable");
});

test("follows survive in the keystore and a damaged entry reads as none", async () => {
  const follow = {
    strategyId: 3,
    name: "A",
    subscriberKey: word("a"),
    expiresAt: "2026-12-23T00:00:00Z",
    copiedSeq: 2,
  };
  await secureFollowStore.save([follow, { ...follow, subscriberKey: "bad" } as never]);
  expect(await secureFollowStore.load()).toEqual([follow]);
  await SecureStore.setItemAsync("gizu.strategies.follows.v1", "{not json");
  expect(await secureFollowStore.load()).toEqual([]);
  await secureFollowStore.setPushDevice("6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f");
  expect(await secureFollowStore.pushDevice()).toBe("6f1b1d4e-2a2b-4c4d-8e8f-0a1b2c3d4e5f");
  await secureFollowStore.setPushDevice(null);
  expect(await secureFollowStore.pushDevice()).toBeNull();
});

test("the signal request sends the subscriber key and checks the basket's shape", async () => {
  const signal = {
    seq: 2,
    commitment: word("c"),
    committedAt: "2026-11-23T00:00:00Z",
    commitTx: word("d"),
    assets: basket,
    salt: word("5"),
  };
  const fetchMock = jest.fn(
    async () =>
      new Response(JSON.stringify({ strategyId: 7, registry: {}, signal }), { status: 200 }),
  );
  global.fetch = fetchMock as never;
  const service = createStrategyService("https://api.example");
  expect(await service.signal(7, word("a"))).toEqual(signal);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.example/v1/strategies/7/signal");
  expect((init.headers as Record<string, string>)["x-subscriber-key"]).toBe(word("a"));

  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ strategyId: 8, signal }), { status: 200 }),
  );
  await expect(service.signal(7, word("a"))).rejects.toThrow("Invalid strategy response.");
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ strategyId: 7, signal: null }), { status: 200 }),
  );
  expect(await service.signal(7, word("a"))).toBeNull();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ code: "PAYMENT_REQUIRED" }), { status: 402 }),
  );
  await expect(service.signal(7, word("a"))).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
});
