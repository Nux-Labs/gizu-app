import {
  createPublicClient,
  http,
  getAddress,
  erc20Abi,
  parseAbi,
  keccak256,
  toHex,
} from "viem";
import type { Hex } from "viem";
import { mainnet } from "viem/chains";
import { ETHEREUM_PROFILE } from "./vault.ts";
import { ROBINHOOD_PROFILE, robinhoodChain } from "./robinhood-vault.ts";
import { ceilDiv } from "./policy.ts";
import { auroraApi } from "../aurora/http.ts";
import {
  ExitSnapshotFailure,
  type ExitSnapshotStage,
} from "./exit-snapshot-error.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../aurora/assets.ts";
export type ExitRequest = {
  profileId: "ethereum-usdc" | "robinhood-usdg";
  owner: string;
};
type State = {
  chainId: number;
  owner: string;
  block: { number: bigint; hash: Hex; timestamp: bigint };
  token: bigint;
  native: bigint;
  wrapped: bigint;
  shares: bigint;
  shareDecimals: number;
};
export interface ExitSnapshotProviders {
  read(request: ExitRequest): Promise<State>;
  prices(): Promise<unknown>;
  canonical(request: ExitRequest, state: State): Promise<void>;
}
export type ExitSnapshotConfig = {
  ethereumRpcUrl?: string;
  robinhoodRpcUrl?: string;
  auroraApiKey?: string;
};
const assetAbi = parseAbi(["function asset() view returns(address)"]);
const ethAsset = "nep141:eth.omft.near";
function profile(id: ExitRequest["profileId"]) {
  return id === "ethereum-usdc"
    ? {
        chainId: 1,
        token: ETHEREUM_PROFILE.usdc,
        wrapped: ETHEREUM_PROFILE.weth,
        vault: ETHEREUM_PROFILE.vault,
        assetId: ethereumUsdcAssetId,
        blockchain: "eth",
      }
    : {
        chainId: 4663,
        token: ROBINHOOD_PROFILE.token,
        wrapped: ROBINHOOD_PROFILE.wrappedNative,
        vault: ROBINHOOD_PROFILE.vault,
        assetId: robinhoodUsdgAssetId,
        blockchain: "hood",
      };
}
function record(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid exit data");
  return v as Record<string, unknown>;
}
function price18(v: unknown, up: boolean) {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  if (
    typeof s !== "string" ||
    s.length > 80 ||
    !/^\d+(?:\.\d+)?(?:e[+-]?\d{1,2})?$/i.test(s)
  )
    throw Error("Invalid asset price");
  const [decimal, exponent = "0"] = s.toLowerCase().split("e"),
    [whole, frac = ""] = decimal!.split(".");
  const digits = BigInt(whole! + frac),
    power = 18 + Number(exponent) - frac.length;
  if (power > 40 || power < -40) throw Error("Invalid asset price precision");
  const value =
    power >= 0
      ? digits * 10n ** BigInt(power)
      : up
        ? ceilDiv(digits, 10n ** BigInt(-power))
        : digits / 10n ** BigInt(-power);
  if (value <= 0n || value >= 2n ** 256n) throw Error("Invalid asset price");
  return value;
}
export function exitPrices(
  raw: unknown,
  id: ExitRequest["profileId"],
  needEth: boolean,
  now: number,
) {
  const rows = record(raw).tokens;
  if (!Array.isArray(rows) || rows.length > 10000)
    throw Error("Invalid price registry");
  const registry = rows as unknown[];
  const p = profile(id);
  let oldest = Number.POSITIVE_INFINITY;
  const updatedAt: Record<string, string> = {};
  function pick(
    asset: "token" | "usdc" | "native",
    assetId: string,
    chain: string,
    decimals: number,
    token?: string,
  ) {
    let priceAgeMs: number | undefined;
    try {
      const matching = registry
        .map(record)
        .filter((r) => r.assetId === assetId);
      if (matching.length !== 1)
        throw Error("Missing or duplicate asset price");
      const r = matching[0]!;
      if (
        r.blockchain !== chain ||
        r.decimals !== decimals ||
        (token &&
          String(r.contractAddress).toLowerCase() !== token.toLowerCase()) ||
        (!token &&
          (r.symbol !== "ETH" ||
            (r.contractAddress != null &&
              ![
                "native",
                "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              ].includes(String(r.contractAddress).toLowerCase()))))
      )
        throw Error("Asset registry changed");
      const t =
        typeof r.priceUpdatedAt === "string"
          ? Date.parse(r.priceUpdatedAt)
          : NaN;
      if (Number.isFinite(t)) priceAgeMs = now - t;
      if (!Number.isFinite(t) || now - t > 300000 || t - now > 5000)
        throw Error("Asset price expired");
      oldest = Math.min(oldest, t);
      updatedAt[assetId] = r.priceUpdatedAt as string;
      return price18(r.price, asset !== "usdc").toString();
    } catch (error) {
      throw new ExitSnapshotFailure("prices-validate", error, {
        asset,
        ...(priceAgeMs !== undefined
          ? { priceAgeMs, priceMaxAgeMs: 300000 }
          : {}),
      });
    }
  }
  const tokenUsd18 = pick("token", p.assetId, p.blockchain, 6, p.token),
    usdcUsd18 = pick(
      "usdc",
      monadUsdcAssetId,
      "monad",
      6,
      "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    ),
    ethUsd18 = needEth ? pick("native", ethAsset, "eth", 18) : null;
  return {
    tokenUsd18,
    usdcUsd18,
    ethUsd18,
    observedAtMs: oldest,
    tokenPriceUpdatedAt: updatedAt[p.assetId]!,
    usdcPriceUpdatedAt: updatedAt[monadUsdcAssetId]!,
    ethPriceUpdatedAt: needEth ? updatedAt[ethAsset]! : null,
  };
}
export class EarnExitSnapshot {
  private providers: ExitSnapshotProviders;
  private now: () => number;
  constructor(
    config: ExitSnapshotConfig,
    providers?: ExitSnapshotProviders,
    now = Date.now,
  ) {
    this.now = now;
    const client = (r: ExitRequest) => {
      const url =
        r.profileId === "ethereum-usdc"
          ? config.ethereumRpcUrl
          : (config.robinhoodRpcUrl ??
            "https://rpc.mainnet.chain.robinhood.com");
      if (!url || !/^https:\/\//.test(url)) throw Error("Exit RPC unavailable");
      return createPublicClient({
        chain: r.profileId === "ethereum-usdc" ? mainnet : robinhoodChain,
        transport: http(url, { timeout: 12000, retryCount: 0 }),
      });
    };
    this.providers = providers ?? {
      read: async (r) => {
        const c = client(r),
          p = profile(r.profileId),
          owner = getAddress(r.owner);
        const chainId = await c.getChainId(),
          b = await c.getBlock();
        if (!b.hash) throw Error("Missing block hash");
        const blockNumber = b.number;
        const [
          token,
          native,
          wrapped,
          shares,
          tokenDecimals,
          wrappedDecimals,
          shareDecimals,
          asset,
          ...code
        ] = await Promise.all([
          c.readContract({
            address: p.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            blockNumber,
          }),
          c.getBalance({ address: owner, blockNumber }),
          c.readContract({
            address: p.wrapped,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            blockNumber,
          }),
          c.readContract({
            address: p.vault,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
            blockNumber,
          }),
          c.readContract({
            address: p.token,
            abi: erc20Abi,
            functionName: "decimals",
            blockNumber,
          }),
          c.readContract({
            address: p.wrapped,
            abi: erc20Abi,
            functionName: "decimals",
            blockNumber,
          }),
          c.readContract({
            address: p.vault,
            abi: erc20Abi,
            functionName: "decimals",
            blockNumber,
          }),
          c.readContract({
            address: p.vault,
            abi: assetAbi,
            functionName: "asset",
            blockNumber,
          }),
          ...[p.token, p.wrapped, p.vault].map((address) =>
            c.getCode({ address, blockNumber }),
          ),
        ]);
        if (
          tokenDecimals !== 6 ||
          wrappedDecimals !== 18 ||
          shareDecimals < 0 ||
          shareDecimals > 36 ||
          asset.toLowerCase() !== p.token.toLowerCase() ||
          code.some((v) => !v || v === "0x")
        )
          throw Error("Asset contract changed");
        return {
          chainId,
          owner,
          block: { number: b.number, hash: b.hash, timestamp: b.timestamp },
          token,
          native,
          wrapped,
          shares,
          shareDecimals,
        };
      },
      prices: async () => {
        if (!config.auroraApiKey) throw Error("Exit prices unavailable");
        let httpStatus: number | undefined;
        try {
          return await auroraApi(
            config.auroraApiKey,
            async (input, init) => {
              const response = await fetch(input, init);
              httpStatus = response.status;
              return response;
            },
            `tokens/{key}?valuationAt=${this.now()}`,
          );
        } catch (error) {
          throw new ExitSnapshotFailure("prices-fetch", error, { httpStatus });
        }
      },
      canonical: async (r, s) => {
        const b = await client(r).getBlock({ blockNumber: s.block.number });
        if (b.hash?.toLowerCase() !== s.block.hash.toLowerCase())
          throw Error("Exit reference changed");
      },
    };
  }
  async read(request: ExitRequest) {
    let stage: ExitSnapshotStage = "request-validate";
    try {
      if (
        !["ethereum-usdc", "robinhood-usdg"].includes(request.profileId) ||
        !/^0x[0-9a-f]{40}$/i.test(request.owner)
      )
        throw Error("Invalid exit request");
      const owner = getAddress(request.owner),
        p = profile(request.profileId);
      stage = "chain-read";
      const s = await this.providers.read({ ...request, owner }),
        now = this.now(),
        at = Number(s.block.timestamp) * 1000;
      stage = "reference-validate";
      if (
        s.chainId !== p.chainId ||
        s.owner.toLowerCase() !== owner.toLowerCase() ||
        s.block.number <= 0n ||
        !Number.isInteger(s.shareDecimals) ||
        s.shareDecimals < 0 ||
        s.shareDecimals > 36 ||
        !/^0x[0-9a-f]{64}$/i.test(s.block.hash) ||
        /^0x0{64}$/i.test(s.block.hash) ||
        now - at > 60000 ||
        at - now > 5000 ||
        [s.token, s.native, s.wrapped, s.shares].some(
          (n) => n < 0n || n >= 2n ** 256n,
        )
      )
        throw Error("Invalid exit reference");
      stage = "prices-fetch";
      const rawPrices = await this.providers.prices();
      stage = "prices-validate";
      const prices = exitPrices(
        rawPrices,
        request.profileId,
        s.native + s.wrapped > 0n,
        this.now(),
      );
      stage = "canonical-check";
      await this.providers.canonical(request, s);
      stage = "valuation";
      const denominator = BigInt(prices.usdcUsd18),
        eth = BigInt(prices.ethUsd18 ?? "0"),
        residual =
          ceilDiv(
            s.token * BigInt(prices.tokenUsd18) * 1000000n,
            1000000n * denominator,
          ) +
          ceilDiv(s.native * eth * 1000000n, 10n ** 18n * denominator) +
          ceilDiv(s.wrapped * eth * 1000000n, 10n ** 18n * denominator);
      const observedAtMs = this.now();
      stage = "freshness";
      const expiresAtMs = Math.min(
        at + 60000,
        prices.observedAtMs + 300000,
        observedAtMs + 60000,
      );
      if (expiresAtMs <= this.now()) throw Error("Exit snapshot expired");
      const result = {
        profileId: request.profileId,
        chainId: p.chainId,
        owner,
        token: p.token,
        wrappedToken: p.wrapped,
        vault: p.vault,
        tokenDecimals: 6,
        wrappedDecimals: 18,
        shareDecimals: s.shareDecimals,
        balances: {
          tokenAtoms: s.token.toString(),
          nativeWei: s.native.toString(),
          wrappedWei: s.wrapped.toString(),
          shares: s.shares.toString(),
        },
        prices,
        priceMaxAgeMs: 300000 as const,
        reference: {
          blockNumber: s.block.number.toString(),
          blockHash: s.block.hash,
          blockTimestampMs: at,
        },
        observedAtMs,
        expiresAtMs,
        residualUsdcAtoms: residual.toString(),
        publicResidualReady: s.shares === 0n && residual < 500000n,
        optimalResidual: s.shares === 0n && residual < 100000n,
        readOnly: true as const,
        completionAttested: false as const,
        walletScope: "investment-only-hold-wallet-excluded" as const,
      };
      return {
        ...result,
        snapshotHash: keccak256(toHex(JSON.stringify(result))),
      };
    } catch (error) {
      throw error instanceof ExitSnapshotFailure
        ? error
        : new ExitSnapshotFailure(stage, error);
    }
  }
}
