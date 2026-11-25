import { FusionSDK, NetworkEnum, RelayerRequest, type PresetEnum } from "@1inch/fusion-sdk";
import { createPublicClient, defineChain, domainSeparator, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const ROBINHOOD_LOP = getAddress("0x5A705DE8982235a7fa45bB83dCaCf03a211389C7");
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
// Probe and reference sizes are 10 and 1,000 units of a 6-decimal settlement stablecoin.
const LIQUIDITY_PROBE_ATOMS = 10_000_000n;
const LIQUIDITY_REFERENCE_ATOMS = 1_000_000_000n;
export const MAX_PRICE_IMPACT_BPS = 100n;

/** A chain swap stock trades on: the Fusion network, its RPC and the stablecoin a buy spends. */
export type FusionChain = {
  id: SwapChainId;
  name: string;
  network: NetworkEnum;
  rpc: string;
  settlementToken: Address;
};
export type SwapChainId = typeof ROBINHOOD_CHAIN_ID | typeof BASE_CHAIN_ID;
export const SWAP_CHAIN_IDS = [ROBINHOOD_CHAIN_ID, BASE_CHAIN_ID] as const;
export const ROBINHOOD_FUSION: FusionChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  network: NetworkEnum.ROBINHOOD,
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  settlementToken: ROBINHOOD_USDG,
};
export const BASE_FUSION: FusionChain = {
  id: BASE_CHAIN_ID,
  name: "Base",
  network: NetworkEnum.COINBASE,
  rpc: "https://mainnet.base.org",
  settlementToken: BASE_USDC,
};
const permitAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

export type FusionPreset = "fast" | "medium" | "slow";
export type FusionPreview = {
  marketOut: string;
  recommendedPreset: string;
  settlement: Address;
  preset: FusionPreset;
  auctionStartAmount: string;
  auctionEndAmount: string;
  auctionDuration: number;
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  liquidity: { impactBps: string; passes: boolean };
};
export type FusionOrderDraft = {
  orderHash: Hex;
  quoteId: string;
  order: { salt: string; maker: string; receiver: string; makerAsset: string; takerAsset: string; makingAmount: string; takingAmount: string; makerTraits: string };
  extension: Hex;
};
export type FusionOrderStatus = { status: string; fills: Array<{ txHash: Hex; filledMakerAmount: string }> };

// Same rule as research `priceImpactBps`: the reference-size rate against a small probe.
export function priceImpactBps(probe: { amountIn: bigint; amountOut: bigint }, reference: { amountIn: bigint; amountOut: bigint }): bigint {
  for (const quote of [probe, reference]) {
    if (quote.amountIn <= 0n || quote.amountOut <= 0n) throw new Error("Liquidity quotes need positive amounts");
  }
  const probeValue = probe.amountOut * reference.amountIn;
  const referenceValue = reference.amountOut * probe.amountIn;
  if (referenceValue >= probeValue) return 0n;
  return (probeValue - referenceValue) * 10_000n / probeValue;
}

export class OneInchFusion {
  private readonly sdk: FusionSDK;
  private readonly client;

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    rpc?: string,
    private readonly pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1_100)),
    readonly chain: FusionChain = ROBINHOOD_FUSION,
  ) {
    this.sdk = new FusionSDK({ url: "https://api.1inch.com/fusion", network: chain.network, authKey: key });
    const viemChain = defineChain({
      id: chain.id,
      name: chain.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [chain.rpc] } },
    });
    this.client = createPublicClient({ chain: viemChain, transport: http(rpc ?? chain.rpc, { timeout: 20_000 }) });
  }

  async preview(
    wallet: Address,
    dstToken: Address,
    amount: bigint,
    preset: FusionPreset,
    srcToken: Address = this.chain.settlementToken,
  ): Promise<FusionPreview> {
    const quote = await this.guard("quote", () => this.sdk.getQuote({
      fromTokenAddress: srcToken,
      toTokenAddress: dstToken,
      amount: amount.toString(),
      walletAddress: wallet,
    }));
    const selected = quote.getPreset(preset as PresetEnum);
    // Buys spend the chain's stablecoin and must clear the liquidity check; sells are not limited.
    const impact = srcToken.toLowerCase() === this.chain.settlementToken.toLowerCase()
      ? await this.liquidityImpact(dstToken)
      : 0n;
    return {
      marketOut: quote.toTokenAmount,
      recommendedPreset: String(quote.recommendedPreset),
      settlement: getAddress(quote.settlementAddress.toString()),
      preset,
      auctionStartAmount: selected.auctionStartAmount.toString(),
      auctionEndAmount: selected.auctionEndAmount.toString(),
      auctionDuration: Number(selected.auctionDuration),
      allowPartialFills: selected.allowPartialFills,
      allowMultipleFills: selected.allowMultipleFills,
      liquidity: { impactBps: impact.toString(), passes: impact <= MAX_PRICE_IMPACT_BPS },
    };
  }

  async permitContext(owner: Address, token: Address = this.chain.settlementToken): Promise<{ name: string; version: string; nonce: string }> {
    return this.guard("permit context", async () => {
      const [name, separator, nonce] = await Promise.all([
        this.client.readContract({ address: token, abi: permitAbi, functionName: "name" }),
        this.client.readContract({ address: token, abi: permitAbi, functionName: "DOMAIN_SEPARATOR" }),
        this.client.readContract({ address: token, abi: permitAbi, functionName: "nonces", args: [owner] }),
      ]);
      for (const version of ["1", "2"]) {
        const domain = { name, version, chainId: this.chain.id, verifyingContract: token };
        if (domainSeparator({ domain }).toLowerCase() === separator.toLowerCase()) {
          return { name, version, nonce: nonce.toString() };
        }
      }
      throw new Error("token DOMAIN_SEPARATOR is not reproducible");
    });
  }

  async createOrder(
    wallet: Address,
    dstToken: Address,
    amount: bigint,
    permit: Hex,
    preset: FusionPreset,
    srcToken: Address = this.chain.settlementToken,
    receiver?: Address,
  ): Promise<FusionOrderDraft> {
    const created = await this.guard("order", () => this.sdk.createOrder({
      fromTokenAddress: srcToken,
      toTokenAddress: dstToken,
      amount: amount.toString(),
      walletAddress: wallet,
      receiver,
      permit,
      preset: preset as PresetEnum,
    }));
    const built = created.order.build();
    return {
      orderHash: created.hash as Hex,
      quoteId: created.quoteId,
      order: {
        salt: String(built.salt),
        maker: String(built.maker),
        receiver: String(built.receiver),
        makerAsset: String(built.makerAsset),
        takerAsset: String(built.takerAsset),
        makingAmount: String(built.makingAmount),
        takingAmount: String(built.takingAmount),
        makerTraits: String(built.makerTraits),
      },
      extension: created.order.extension.encode() as Hex,
    };
  }

  async submit(signed: { order: FusionOrderDraft["order"]; signature: Hex; quoteId: string; extension: Hex }): Promise<void> {
    await this.guard("submit", () => this.sdk.api.submitOrder(RelayerRequest.new({
      order: signed.order,
      signature: signed.signature,
      quoteId: signed.quoteId,
      extension: signed.extension,
    })));
  }

  async status(orderHash: Hex): Promise<FusionOrderStatus | null> {
    try {
      const status = await this.guard("status", () => this.sdk.getOrderStatus(orderHash));
      return {
        status: String(status.status),
        fills: status.fills.map((fill) => ({ txHash: fill.txHash as Hex, filledMakerAmount: String(fill.filledMakerAmount) })),
      };
    } catch (error) {
      if (error instanceof InfrastructureError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private async liquidityImpact(dstToken: Address): Promise<bigint> {
    const probe = await this.aggregatorQuote(dstToken, LIQUIDITY_PROBE_ATOMS);
    await this.pause();
    const reference = await this.aggregatorQuote(dstToken, LIQUIDITY_REFERENCE_ATOMS);
    return priceImpactBps(
      { amountIn: LIQUIDITY_PROBE_ATOMS, amountOut: probe },
      { amountIn: LIQUIDITY_REFERENCE_ATOMS, amountOut: reference },
    );
  }

  private async aggregatorQuote(dstToken: Address, amount: bigint): Promise<bigint> {
    const url = new URL(`https://api.1inch.com/swap/v6.1/${this.chain.id}/quote`);
    url.searchParams.set("src", this.chain.settlementToken);
    url.searchParams.set("dst", dstToken);
    url.searchParams.set("amount", amount.toString());
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.key}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new InfrastructureError(503, "ONEINCH_UNAVAILABLE", "1inch liquidity quote unavailable");
    }
    if (!response.ok) throw new InfrastructureError(422, "ONEINCH_NO_LIQUIDITY", `1inch liquidity quote failed (${response.status})`);
    const body = (await response.json()) as { dstAmount?: unknown };
    if (typeof body.dstAmount !== "string" || !/^\d+$/.test(body.dstAmount)) {
      throw new InfrastructureError(502, "ONEINCH_INVALID", "1inch liquidity quote is invalid");
    }
    return BigInt(body.dstAmount);
  }

  // Axios errors carry the Authorization header, so only the status and a short reason leave this adapter.
  private async guard<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      const failure = error as { response?: { status?: number; data?: unknown }; message?: string };
      const status = failure.response?.status;
      const data = failure.response?.data as { description?: unknown; message?: unknown; error?: unknown } | string | undefined;
      const reason = typeof data === "string" ? data : String(data?.description ?? data?.message ?? data?.error ?? failure.message ?? "");
      const clean = reason.split(this.key).join("<key>").slice(0, 200);
      if (status === 404) throw new InfrastructureError(404, "FUSION_NOT_FOUND", `1inch Fusion ${what}: not found`);
      if (status && status < 500) throw new InfrastructureError(422, "FUSION_REJECTED", `1inch Fusion ${what} rejected: ${clean}`);
      throw new InfrastructureError(503, "FUSION_UNAVAILABLE", `1inch Fusion ${what} failed: ${clean}`);
    }
  }
}
