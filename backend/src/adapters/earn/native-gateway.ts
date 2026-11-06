import { z } from "zod";
import { OperationCoordinator, CoordinationError } from "./operation-coordinator.ts";
import { EarnRecoveryEnvelope } from "./recovery-envelope.ts";
import { getAddress, keccak256, toHex, recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import {
  entryPoint08Address,
  getUserOperationTypedData,
  getUserOperationHash,
} from "viem/account-abstraction";
import type { UserOperation } from "viem/account-abstraction";
import { recoverAuthorizationAddress } from "viem/utils";
import { auroraApi, AuroraRouteUnavailable } from "../aurora/http.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../aurora/assets.ts";
import {
  monadUsdc,
  tokenPaymaster,
  sourceFeeCap,
} from "../pimlico/source-funding.ts";
import { ROBINHOOD_PROFILE } from "./robinhood-vault.ts";
import { robinhoodTokenCap } from "./robinhood-paymaster.ts";
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .transform((v) => getAddress(v));
const decimal = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const operationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[-a-zA-Z0-9_]+$/);
const recoveryEnvelope = z.string().min(1).max(180000);
const revision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const qty = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/)
  .max(66);
const bytes = (max: number) =>
  z
    .string()
    .regex(/^0x(?:[0-9a-f]{2})*$/i)
    .max(2 + max * 2);
// Simple7702 SDK simulation signature. Never accepted for submission or native signing.
const simple7702SimulationSignature =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
const impl = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ethAsset = "nep141:eth.omft.near";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
import { parseAuroraFeeQualification, qualifyAuroraFees, hasAuroraProfileQualification, auroraFeeProofSchema, type AuroraFeeQualification, type AuroraFeeProof } from "./fee-policy.ts";
export { parseAuroraFeeQualification } from "./fee-policy.ts";
export type { AuroraFeeQualification } from "./fee-policy.ts";
export const nativeQuoteInput = z
  .object({
    operationId,
    revision,
    profileChainId: z.union([z.literal(1), z.literal(4663)]),
    sourceOwner: address,
    confidentialAccount: address,
    amountAtoms: decimal,
    returnAsset: z.enum(["usdc", "native"]).optional(),
    settlementMode: z.literal("balance-delta-v1").optional(),
    recoveryEnvelope: recoveryEnvelope.optional(),
  })
  .strict();
export type NativeQuoteInput = z.input<typeof nativeQuoteInput>;
export const nativeQuoteBindingInput = z
  .object({
    operationId,
    revision,
    quoteId: hash,
    chainId: z.union([z.literal(1), z.literal(143), z.literal(4663)]),
    token: address,
    amountAtoms: decimal,
    confidentialAccount: address,
    refundOwner: address,
    recipient: address,
    recoveryEnvelope: recoveryEnvelope.optional(),
  })
  .strict();
export type NativeQuoteBindingInput = z.input<typeof nativeQuoteBindingInput>;
export interface NativeVerifiedQuote {
  readonly operationId: string;
  readonly revision: number;
  readonly quoteId: Hex;
  readonly recipient: Address;
  readonly amountAtoms: string;
  readonly chainId: 1 | 143 | 4663;
  readonly token: Address;
  readonly confidentialAccount: Address;
  readonly refundOwner: Address;
  readonly expiresAt: number;
  readonly authenticatedBodyHash: Hex;
  readonly minimumCreditAtoms: string;
  readonly maximumCreditAtoms?: string;
  readonly providerFeeBps: number;
  readonly feePolicy?: AuroraFeeProof;
  readonly originAsset: string;
  readonly recoveryEnvelope?: string;
}
export interface NativeSettlementQuote extends NativeVerifiedQuote {
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly quoteCreatedAt: number;
}
/** Fee admission binds observed route-specific service charges and the configured
 * zero Gizu/integrator fee. It does not infer collector ownership from a quote. */
export interface NativeGatewayConfiguration {
  coordination?: OperationCoordinator;
  recoveryKey?: string;
  pimlicoApiKey?: string;
  auroraApiKey?: string;
  auroraHistoryQualified?: boolean;
  auroraFeeQualification?: AuroraFeeQualification;
}
const rpcRequest = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([
      z.number().int().min(0).max(2147483647),
      z.string().min(1).max(64),
    ]),
    method: z.enum([
      "pm_getPaymasterData",
      "eth_sendUserOperation",
      "eth_getUserOperationReceipt",
      "eth_getUserOperationByHash",
      "eth_supportedEntryPoints",
    ]),
    params: z.array(z.unknown()).max(4),
  })
  .strict();
const auth = z
  .object({
    chainId: qty,
    address: address,
    nonce: qty,
    r: hash,
    s: hash,
    yParity: z.enum(["0x00", "0x01", "0x0", "0x1"]),
  })
  .strict();
const gasFields = [
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
] as const;
const opSchema = z
  .object({
    sender: address,
    nonce: qty,
    callData: bytes(16384),
    callGasLimit: qty,
    verificationGasLimit: qty,
    preVerificationGas: qty,
    maxFeePerGas: qty,
    maxPriorityFeePerGas: qty,
    paymaster: address,
    paymasterData: bytes(4096),
    paymasterVerificationGasLimit: qty,
    paymasterPostOpGasLimit: qty,
    signature: bytes(65),
    factory: z.literal("0x7702").optional(),
    factoryData: z.literal("0x").optional(),
    eip7702Auth: auth.optional(),
  })
  .strict();
const logSchema = z.object({
  address,
  topics: z.array(hash).max(4),
  data: bytes(16384),
  blockHash: hash.nullable().optional(),
  blockNumber: qty.nullable().optional(),
  transactionHash: hash.nullable().optional(),
  transactionIndex: qty.nullable().optional(),
  logIndex: qty.nullable().optional(),
  removed: z.boolean().optional(),
});
const chainReceiptSchema = z.object({
  transactionHash: hash,
  blockHash: hash,
  blockNumber: qty,
  from: address.optional(),
  to: address.nullable().optional(),
  contractAddress: address.nullable().optional(),
  transactionIndex: qty.optional(),
  gasUsed: qty.optional(),
  cumulativeGasUsed: qty.optional(),
  effectiveGasPrice: qty.optional(),
  status: qty.optional(),
  type: qty.optional(),
  logsBloom: bytes(256).optional(),
  logs: z.array(logSchema).max(512).optional(),
});
const userReceiptSchema = z.object({
  userOpHash: hash,
  entryPoint: address,
  sender: address,
  nonce: qty,
  paymaster: address.optional(),
  actualGasCost: qty,
  actualGasUsed: qty,
  success: z.boolean(),
  reason: bytes(16384).optional(),
  logs: z.array(logSchema).max(512).optional(),
  receipt: chainReceiptSchema,
});
const byHashSchema = z.object({
  entryPoint: address,
  userOperation: opSchema,
  blockHash: hash.nullable().optional(),
  blockNumber: qty.nullable().optional(),
  transactionHash: hash.nullable().optional(),
});
// Historical provider responses use null for absent deployment fields and JSON
// numbers for 7702 quantities. Normalize that representation before the same
// strict schema, signature and hash checks. Signed submission requests never use this path.
function normalizeHistoricalOperation(result: unknown): unknown {
  const envelope = object(result);
  const op = { ...object(envelope.userOperation) };
  for (const k of ["factory", "factoryData", "eip7702Auth"])
    if (op[k] === null) delete op[k];
  if (op.eip7702Auth) {
    const auth = { ...object(op.eip7702Auth) };
    for (const k of ["chainId", "nonce", "yParity"])
      if (typeof auth[k] === "number") {
        if (!Number.isSafeInteger(auth[k]) || (auth[k] as number) < 0)
          throw new Error("Invalid authorization quantity");
        auth[k] = toHex(auth[k] as number, k === "yParity" ? { size: 1 } : {});
      }
    op.eip7702Auth = auth;
  }
  return {
    ...envelope,
    userOperation: op,
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid time");
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error("Invalid time");
  return Math.floor(n / 1000);
}
function nullField(v: unknown): boolean {
  return v === undefined || v === null;
}
export class NativeGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const recoveredQuote = z.object({
  operationId, revision, quoteId: hash.transform(v => v as Hex), recipient: address, amountAtoms: decimal,
  chainId: z.union([z.literal(1),z.literal(143),z.literal(4663)]), token: address,
  confidentialAccount: address, refundOwner: address, expiresAt: z.number().int().positive(),
  authenticatedBodyHash: hash.transform(v => v as Hex), minimumCreditAtoms: decimal, maximumCreditAtoms: decimal.optional(), providerFeeBps: z.number().int().min(0).max(100),
  feePolicy: auroraFeeProofSchema.optional(),
  originAsset: z.string().min(1).max(200),
}).strict();
const recoveredCached = z.object({
  quote: recoveredQuote,
  settlement: recoveredQuote.extend({destinationAsset:z.literal(monadUsdcAssetId),quoteCreatedAt:z.number().int().positive()}),
  fingerprint:z.string().min(1).max(4096),retireAt:z.number().int().positive(),
}).strict();
interface Cached {
  quote: NativeVerifiedQuote;
  settlement: NativeSettlementQuote;
  fingerprint: string;
  retireAt: number;
}
/** No signing or private keys. Only bounded, fixed providers and native signed operations. */
export class NativeEarnGateway {
  private fetcher: typeof fetch;
  private now: () => number;
  private active = 0;
  private quotes = new Map<string, Cached>();
  private inflight = new Map<
    string,
    { fingerprint: string; promise: Promise<NativeVerifiedQuote> }
  >();
  private rates = new Map<string, { since: number; count: number }>();
  private qualification?: AuroraFeeQualification;
  private recovery: EarnRecoveryEnvelope;
  constructor(
    private config: NativeGatewayConfiguration = {},
    dependencies: { fetcher?: typeof fetch; now?: () => number } = {},
  ) {
    this.recovery = new EarnRecoveryEnvelope(config.recoveryKey);
    this.fetcher = dependencies.fetcher ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.qualification = config.auroraFeeQualification
      ? parseAuroraFeeQualification(JSON.stringify(config.auroraFeeQualification))
      : undefined;
  }
  private key(operation: string, revision: number) {
    return `${operation}:${revision}`;
  }
  private prune() {
    const n = this.now();
    for (const [k, v] of this.quotes)
      if (v.retireAt <= n) this.quotes.delete(k);
    for (const [k, v] of this.rates)
      if (v.since + 60000 <= n) this.rates.delete(k);
  }
  private async limited<T>(client: string, fn: () => Promise<T>): Promise<T> {
    this.prune();
    const k = client.slice(0, 128),
      n = this.now(),
      r = this.rates.get(k);
    if (
      (r && r.count >= 30) ||
      (!r && this.rates.size >= 1024) ||
      this.active >= 4
    )
      throw new NativeGatewayError(429, "EARN_NATIVE_RATE_LIMIT");
    this.rates.set(
      k,
      r ? { ...r, count: r.count + 1 } : { since: n, count: 1 },
    );
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
  /** Informational only: never cached, never assigned a deposit address or signing binding. */
  async sourcePreview(value: NativeQuoteInput, client = "internal") {
    const input = nativeQuoteInput.parse(value);
    if (input.returnAsset || input.recoveryEnvelope) throw new NativeGatewayError(400,"INVALID_NATIVE_QUOTE");
    if (!this.config.auroraApiKey) throw new NativeGatewayError(503,"EARN_NATIVE_UNAVAILABLE");
    return this.limited(client, async () => {
      const quotedAtMs=this.now();
      const request = {dry:true,swapType:"EXACT_INPUT",depositType:"ORIGIN_CHAIN",depositMode:"SIMPLE",confidentiality:"advanced",amount:input.amountAtoms,originAsset:monadUsdcAssetId,destinationAsset:monadUsdcAssetId,slippageTolerance:0,refundTo:input.sourceOwner.toLowerCase(),refundType:"ORIGIN_CHAIN",recipient:input.confidentialAccount.toLowerCase(),recipientType:"CONFIDENTIAL_INTENTS",deadline:new Date(quotedAtMs+600000).toISOString()};
      try {
        const body=await auroraApi(this.config.auroraApiKey!,this.fetcher,"quote/{key}",request), qr=object(body.quoteRequest), q=object(body.quote);
        for (const [k,v] of Object.entries(request)) if (typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) ? typeof qr[k] !== "string" || !same(qr[k] as string,v) : qr[k] !== v) throw new Error("Changed preview");
        const appFees=z.array(z.object({recipient:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),fee:z.number().int().min(0).max(100)}).strict()).max(8).parse(qr.appFees??[]);
        const providerFeeBps=appFees.reduce((sum,f)=>sum+f.fee,0);
        if(providerFeeBps>100 || new Set(appFees.map(f=>f.recipient)).size!==appFees.length) throw new Error("Invalid fees");
        const referral=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).nullable().parse(qr.referral??null);
        const minimum=decimal.parse(q.minAmountOut),out=decimal.parse(q.amountOut);
        if(q.amountIn!==input.amountAtoms || q.minAmountIn!==input.amountAtoms || BigInt(minimum)>BigInt(out)||BigInt(out)>BigInt(input.amountAtoms)) throw new Error("Invalid preview amount");
        const blockers:string[]=[];
        try {qualifyAuroraFees(this.qualification,"source",qr);if(!hasAuroraProfileQualification(this.qualification,input.profileChainId)) throw new Error("Incomplete profile fees");}catch {blockers.push("EARN_AURORA_FEE_UNQUALIFIED");}
        if(!this.recovery.configured) blockers.push("EARN_RECOVERY_UNAVAILABLE");
        // Dry responses omit executable expiry fields; never turn this local preview TTL into signing authority.
        const expiresAtMs=Math.min(q.deadline==null?Infinity:time(q.deadline)*1000,q.timeWhenInactive==null?Infinity:time(q.timeWhenInactive)*1000,quotedAtMs+60000);
        if(expiresAtMs<=this.now()+15000) throw new Error("Expired preview");
        return {quoteAvailable:true,version:"gizu-source-preview-v1",sourceOwner:input.sourceOwner,confidentialAccount:input.confidentialAccount,amountAtoms:input.amountAtoms,minimumCreditAtoms:minimum,providerFeeBps,appFees,referral,blockers,executionAvailable:false as const,quotedAtMs,expiresAtMs};
      }catch(error) {
        if(error instanceof AuroraRouteUnavailable) {
          const blockers:string[]=[];
          if(!hasAuroraProfileQualification(this.qualification,input.profileChainId))blockers.push("EARN_AURORA_FEE_UNQUALIFIED");
          if(!this.recovery.configured)blockers.push("EARN_RECOVERY_UNAVAILABLE");
          blockers.push("EARN_AURORA_ROUTE_UNAVAILABLE");
          const quotedAtMs=this.now();
          return {quoteAvailable:false,version:"gizu-source-preview-v1",sourceOwner:input.sourceOwner,confidentialAccount:input.confidentialAccount,amountAtoms:input.amountAtoms,minimumCreditAtoms:null,providerFeeBps:null,appFees:[],referral:null,blockers,executionAvailable:false as const,quotedAtMs,expiresAtMs:quotedAtMs+60000};
        }
        if(error instanceof NativeGatewayError) throw error;
        throw new NativeGatewayError(502,"EARN_NATIVE_QUOTE_UNAVAILABLE");
      }
    });
  }
  sourceQuote(input: NativeQuoteInput, client = "internal") {
    return this.createQuote("source", input, client);
  }
  returnQuote(input: NativeQuoteInput, client = "internal") {
    return this.createQuote("return", input, client);
  }
  private async createQuote(
    kind: "source" | "return",
    value: NativeQuoteInput,
    client: string,
  ): Promise<NativeVerifiedQuote> {
    let input: z.output<typeof nativeQuoteInput>;
    try {
      input = nativeQuoteInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_NATIVE_QUOTE");
    }
    if (
      (kind === "source" && input.returnAsset !== undefined) ||
      (input.profileChainId === 4663 && input.returnAsset !== undefined)
    )
      throw new NativeGatewayError(400, "INVALID_NATIVE_QUOTE");
    if (!this.config.auroraApiKey || !this.qualification || (kind === "source" && !hasAuroraProfileQualification(this.qualification,input.profileChainId))) throw new NativeGatewayError(503,"EARN_AURORA_FEE_UNQUALIFIED");
    if(input.settlementMode !== "balance-delta-v1" && !this.config.auroraHistoryQualified) throw new NativeGatewayError(503,"EARN_NATIVE_UPGRADE_REQUIRED");
    const { recoveryEnvelope: envelope, ...originalInput } = input;
    const fingerprint = JSON.stringify({ kind, ...originalInput }),
      key = this.key(input.operationId, input.revision);
    this.prune();
    if (envelope) this.restoreQuote(envelope, key);
    const cached = this.quotes.get(key);
    if (cached) {
      if (
        cached.fingerprint !== fingerprint ||
        cached.quote.expiresAt <= this.now() / 1000
      )
        throw new NativeGatewayError(409, "EARN_QUOTE_BINDING_CHANGED");
      await this.config.coordination?.bind("native-quote", key, fingerprint, cached.retireAt);
      return cached.quote;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new NativeGatewayError(409, "EARN_QUOTE_BINDING_CHANGED");
      return pending.promise;
    }
    if (!this.config.auroraApiKey || !this.qualification)
      throw new NativeGatewayError(503, "EARN_AURORA_FEE_UNQUALIFIED");
    if (!this.recovery.configured)
      throw new NativeGatewayError(503, "EARN_RECOVERY_UNAVAILABLE");
    if (this.quotes.size + this.inflight.size >= 1024)
      throw new NativeGatewayError(503, "EARN_QUOTE_CAPACITY");
    const promise = this.limited(client, async () => {
      try {
        if (this.config.coordination) {
          await this.config.coordination.bind("native-quote", key, fingerprint, this.now()+86400000);
          if (!await this.config.coordination.claim("native-quote-issue", key, fingerprint, this.now()+86400000)) throw new CoordinationError();
        }
        const isSource = kind === "source",
          isEth = input.profileChainId === 1;
        const originAsset = isSource
          ? monadUsdcAssetId
          : isEth
            ? input.returnAsset === "native"
              ? ethAsset
              : ethereumUsdcAssetId
            : robinhoodUsdgAssetId;
        const token = isSource
          ? monadUsdc
          : isEth
            ? input.returnAsset === "native"
              ? native
              : "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
            : ROBINHOOD_PROFILE.token;
        const chainId = isSource ? 143 : input.profileChainId;
        const seconds = Math.floor(this.now() / 1000);
        const request = {
          dry: false,
          swapType: "EXACT_INPUT",
          depositType: "ORIGIN_CHAIN",
          depositMode: "SIMPLE",
          confidentiality: "advanced",
          amount: input.amountAtoms,
          originAsset,
          destinationAsset: monadUsdcAssetId,
          slippageTolerance: 0,
          refundTo: input.sourceOwner.toLowerCase(),
          refundType: "ORIGIN_CHAIN",
          recipient: input.confidentialAccount.toLowerCase(),
          recipientType: "CONFIDENTIAL_INTENTS",
          deadline: new Date((seconds + 600) * 1000).toISOString(),
        };
        const body = await auroraApi(
          this.config.auroraApiKey!,
          this.fetcher,
          "quote/{key}",
          request,
        );
        const qr = object(body.quoteRequest),
          q = object(body.quote);
        for (const [k, v] of Object.entries(request))
          if (
            typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v)
              ? typeof qr[k] !== "string" || !same(qr[k] as string, v)
              : qr[k] !== v
          )
            throw new Error("Changed quote binding");
        let feePolicy: AuroraFeeProof;
        try { feePolicy = qualifyAuroraFees(this.qualification, isSource ? "source" : isEth ? input.returnAsset === "native" ? "returnEth" : "returnUsdc" : "returnRobinhood", qr); }
        catch { throw new NativeGatewayError(503, "EARN_AURORA_FEE_UNQUALIFIED"); }
        if (
          !nullField(qr.virtualChainRecipient) ||
          !nullField(qr.virtualChainRefundRecipient) ||
          !nullField(qr.customRecipientMsg) ||
          (!nullField(qr.connectedWallets) &&
            (!Array.isArray(qr.connectedWallets) || qr.connectedWallets.length))
        )
          throw new Error("Unqualified fee policy");
        if (
          typeof body.signature !== "string" ||
          body.signature.length < 1 ||
          body.signature.length > 4096 ||
          Math.abs(time(body.timestamp) - seconds) > 60
        )
          throw new Error("Unauthenticated quote");
        const depositAddress = address.parse(q.depositAddress);
        if (
          same(depositAddress, input.sourceOwner) ||
          same(depositAddress, input.confidentialAccount) ||
          q.amountIn !== input.amountAtoms ||
          q.minAmountIn !== input.amountAtoms ||
          !nullField(q.depositMemo) ||
          !nullField(q.chainDepositAddresses) ||
          !nullField(q.virtualChainRecipient) ||
          !nullField(q.virtualChainRefundRecipient) ||
          !nullField(q.customRecipientMsg)
        )
          throw new Error("Invalid deposit");
        const out = BigInt(decimal.parse(q.amountOut)),
          minimum = BigInt(decimal.parse(q.minAmountOut));
        if (minimum > out || out === 0n) throw new Error("Invalid credit");
        for (const fee of [q.refundFee, q.withdrawFee])
          if (
            !nullField(fee) &&
            !z
              .string()
              .regex(/^(0|[1-9][0-9]{0,77})$/)
              .safeParse(fee).success
          )
            throw new Error("Invalid fees");
        const expiresAt = Math.min(
          time(q.deadline),
          time(qr.deadline),
          q.timeWhenInactive === undefined
            ? Infinity
            : time(q.timeWhenInactive),
        );
        if (
          expiresAt <= Math.floor(this.now() / 1000) + 15 ||
          expiresAt > seconds + 600
        )
          throw new Error("Inactive quote");
        const authenticatedBodyHash = keccak256(toHex(JSON.stringify(body)));
        const quoteId = keccak256(
          toHex(
            JSON.stringify({
              operationId: input.operationId,
              revision: input.revision,
              authenticatedBodyHash,
              feePolicy,
            }),
          ),
        );
        const quote = Object.freeze({
          operationId: input.operationId,
          revision: input.revision,
          quoteId,
          recipient: depositAddress,
          amountAtoms: input.amountAtoms,
          chainId,
          token: getAddress(token),
          confidentialAccount: input.confidentialAccount,
          refundOwner: input.sourceOwner,
          expiresAt,
          authenticatedBodyHash,
          minimumCreditAtoms: minimum.toString(),
          maximumCreditAtoms: out.toString(),
          providerFeeBps: feePolicy.totalBps,
          feePolicy,
          originAsset,
        });
        for (const c of this.quotes.values())
          if (same(c.quote.recipient, quote.recipient))
            throw new Error("Reused deposit address");
        const settlement = Object.freeze({
          ...quote,
          originAsset,
          destinationAsset: monadUsdcAssetId,
          quoteCreatedAt: time(body.timestamp),
        });
        await this.config.coordination?.bind("native-recipient", quote.recipient.toLowerCase(), key, this.now()+86400000);
        const saved = { quote, settlement, fingerprint, retireAt: this.now() + 86400000 };
        const envelope = this.recovery.seal("native-quote", saved);
        const portable = Object.freeze({ ...quote, recoveryEnvelope: envelope });
        this.quotes.set(key, { ...saved, quote: portable });
        return portable;
      } catch (error) {
        if (error instanceof NativeGatewayError || error instanceof CoordinationError) throw error;
        throw new NativeGatewayError(502, "EARN_NATIVE_QUOTE_UNAVAILABLE");
      }
    });
    this.inflight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }
  private restoreQuote(envelope: string, expectedKey: string): void {
    try {
      const restored = recoveredCached.parse(this.recovery.open("native-quote", envelope));
      const key = this.key(restored.quote.operationId, restored.quote.revision);
      if (key !== expectedKey || restored.retireAt <= this.now() ||
          Math.abs(restored.retireAt - 86400000 - (restored.settlement.quoteCreatedAt * 1000)) > 60000 ||
          restored.quote.expiresAt > Math.floor((restored.retireAt - 86400000) / 1000) + 600 ||
          restored.quote.expiresAt <= Math.floor((restored.retireAt - 86400000) / 1000))
        throw new Error("Invalid recovered lifetime");
      for (const [k,v] of Object.entries(restored.quote))
        if (JSON.stringify(restored.settlement[k as keyof typeof restored.settlement]) !== JSON.stringify(v))
          throw new Error("Changed recovered settlement");
      const existing = this.quotes.get(key);
      if (existing && (existing.fingerprint !== restored.fingerprint || existing.quote.quoteId !== restored.quote.quoteId))
        throw new Error("Conflicting recovered operation");
      if (!existing && this.quotes.size + this.inflight.size >= 1024)
        throw new Error("Recovery capacity");
      for (const [otherKey, other] of this.quotes)
        if (otherKey !== key && same(other.quote.recipient, restored.quote.recipient))
          throw new Error("Reused recovered deposit");
      this.quotes.set(key, { ...restored, quote: Object.freeze({...restored.quote, recoveryEnvelope:envelope}) });
    } catch {
      throw new NativeGatewayError(409, "EARN_QUOTE_RECOVERY_REJECTED");
    }
  }
  quoteBinding(value: NativeQuoteBindingInput): NativeVerifiedQuote {
    let input: z.output<typeof nativeQuoteBindingInput>;
    try {
      input = nativeQuoteBindingInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_QUOTE_BINDING");
    }
    if (input.recoveryEnvelope) this.restoreQuote(input.recoveryEnvelope, this.key(input.operationId, input.revision));
    const cached = this.quotes.get(this.key(input.operationId, input.revision));
    if (
      !cached ||
      cached.retireAt <= this.now() ||
      cached.quote.expiresAt <= this.now() / 1000
    )
      throw new NativeGatewayError(409, "EARN_QUOTE_UNKNOWN_OR_EXPIRED");
    if (!cached.quote.maximumCreditAtoms && !this.config.auroraHistoryQualified) throw new NativeGatewayError(503,"EARN_NATIVE_UPGRADE_REQUIRED");
    for (const [k, v] of Object.entries(input)) {
      if (k === "recoveryEnvelope") continue;
      const expected = cached.quote[k as keyof NativeVerifiedQuote];
      if (
        typeof expected === "string" && expected.startsWith("0x")
          ? typeof v !== "string" || !same(expected, v)
          : v !== expected
      )
        throw new NativeGatewayError(409, "EARN_QUOTE_BINDING_CHANGED");
    }
    return cached.quote;
  }
  verifiedQuoteForSettlement(
    operation: string,
    rev: number,
    id: string,
  ): NativeSettlementQuote {
    const c = this.quotes.get(this.key(operation, rev));
    if (!c || c.retireAt <= this.now() || !same(c.quote.quoteId, id))
      throw new NativeGatewayError(409, "EARN_QUOTE_UNKNOWN");
    return c.settlement;
  }
  private async validateOperation(
    value: unknown,
    chainId: 143 | 4663,
    signed: boolean,
    historical = false,
  ): Promise<UserOperation<"0.8">> {
    const op = opSchema.parse(value);
    const token = chainId === 143 ? monadUsdc : ROBINHOOD_PROFILE.token;
    if (!same(op.paymaster, tokenPaymaster))
      throw new Error("Unsupported paymaster");
    for (const field of gasFields)
      if (
        BigInt(op[field]) === 0n ||
        BigInt(op[field]) >= 1n << 128n ||
        BigInt(op[field]) > 20000000n
      )
        throw new Error("Gas limit out of bounds");
    if (
      BigInt(op.maxFeePerGas) === 0n ||
      BigInt(op.maxFeePerGas) >= 1n << 128n ||
      BigInt(op.maxPriorityFeePerGas) > BigInt(op.maxFeePerGas)
    )
      throw new Error("Invalid gas fee");
    if (op.callData === "0x" || op.paymasterData.length < 366)
      throw new Error("Empty operation");
    const raw = op.paymasterData.slice(2).toLowerCase();
    if (
      !["02", "03"].includes(raw.slice(0, 2)) ||
      raw.slice(2, 4) !== "00" ||
      !same("0x" + raw.slice(28, 68), token) ||
      BigInt("0x" + raw.slice(100, 164)) === 0n
    )
      throw new Error("Unsupported token mode");
    const now = Math.floor(this.now() / 1000),
      until = Number(BigInt("0x" + raw.slice(4, 16))),
      after = Number(BigInt("0x" + raw.slice(16, 28)));
    if (!historical && (after > now + 5 || (until !== 0 && until <= now + 10)))
      throw new Error("Expired sponsorship");
    if ((op.factory === undefined) !== (op.factoryData === undefined))
      throw new Error("Unbound delegation");
    let authorization: UserOperation<"0.8">["authorization"];
    if (op.eip7702Auth) {
      const a = op.eip7702Auth;
      if (
        BigInt(a.chainId) !== BigInt(chainId) ||
        !same(a.address, impl) ||
        BigInt(a.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error("Invalid authorization");
      authorization = {
        chainId,
        address: a.address,
        nonce: Number(BigInt(a.nonce)),
        r: a.r as Hex,
        s: a.s as Hex,
        yParity: Number(BigInt(a.yParity)),
      };
      if (
        !same(await recoverAuthorizationAddress({ authorization }), op.sender)
      )
        throw new Error("Unauthorized delegation");
    }
    if (op.factory && !authorization)
      // Hash substitution for an already delegated account. This is never sent.
      authorization = {
        address: getAddress(impl),
      } as UserOperation<"0.8">["authorization"];
    const typed = {
      ...op,
      ...Object.fromEntries(
        [...gasFields, "nonce", "maxFeePerGas", "maxPriorityFeePerGas"].map(
          (k) => [k, BigInt(op[k as keyof typeof op] as string)],
        ),
      ),
      ...(authorization ? { authorization } : {}),
    } as unknown as UserOperation<"0.8">;
    if (chainId === 143) sourceFeeCap(typed);
    else robinhoodTokenCap(typed);
    if (signed) {
      if (
        op.signature.length !== 132 ||
        !same(
          await recoverTypedDataAddress({
            ...getUserOperationTypedData({
              chainId,
              entryPointAddress: entryPoint08Address,
              userOperation: typed,
            }),
            signature: op.signature as Hex,
          }),
          op.sender,
        )
      )
        throw new Error("Unauthorized operation");
    } else if (op.signature !== "0x")
      throw new Error("Preview must be unsigned");
    return typed;
  }
  async bundler(
    chain: number,
    value: unknown,
    client = "internal",
  ): Promise<Record<string, unknown>> {
    return this.limited(client, () => this.bundlerRequest(chain, value));
  }
  private async bundlerRequest(
    chain: number,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    let req: z.infer<typeof rpcRequest>;
    try {
      if (chain !== 143 && chain !== 4663) throw new Error("Unsupported chain");
      req = rpcRequest.parse(value);
      if (JSON.stringify(req).length > 65536)
        throw new Error("Payload too large");
      const p = req.params;
      if (req.method === "eth_supportedEntryPoints") {
        if (p.length) throw new Error("Unexpected params");
      } else if (
        req.method === "eth_getUserOperationReceipt" ||
        req.method === "eth_getUserOperationByHash"
      ) {
        if (p.length !== 1) throw new Error("Unexpected params");
        hash.parse(p[0]);
      } else {
        const pm = req.method === "pm_getPaymasterData";
        if (
          p.length !== (pm ? 4 : 2) ||
          typeof p[1] !== "string" ||
          !same(p[1], entryPoint08Address)
        )
          throw new Error("Unsupported entry point");
        if (
          pm &&
          (p[2] !== toHex(chain) ||
            !same(
              z.object({ token: address }).strict().parse(p[3]).token,
              chain === 143 ? monadUsdc : ROBINHOOD_PROFILE.token,
            ))
        )
          throw new Error("Unsupported sponsor");
        await this.validateOperation(p[0], chain, !pm);
      }
    } catch {
      throw new NativeGatewayError(400, "INVALID_NATIVE_USER_OPERATION");
    }
    if (!this.config.pimlicoApiKey)
      throw new NativeGatewayError(503, "EARN_BUNDLER_UNCONFIGURED");
    if (req.method === "eth_sendUserOperation" && this.config.coordination) {
      const op=opSchema.parse(req.params[0]);
      const identity=[chain,op.sender.toLowerCase(),op.nonce];
      const signed={...op,signature:op.signature.toLowerCase()};
      // An uncertain first send is reconciled by userOp hash; never broadcast twice.
      if (!await this.config.coordination.claim("bundler-send",identity,signed,this.now()+7*86400000))
        return {jsonrpc:"2.0",id:req.id,error:{code:-32001,message:"Submission already attempted; reconcile by operation hash."}};
    }
    return (async () => {
      try {
        const response = await this.fetcher(
          `https://api.pimlico.io/v2/${chain}/rpc?apikey=${encodeURIComponent(this.config.pimlicoApiKey!)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            // The phone supplies an unsigned operation. Pimlico simulates account validation
            // and needs the same non-authorizing 65-byte placeholder used by the SDK.
            // Only this final-sponsorship request is adapted; signed sends stay byte-for-byte.
            body: JSON.stringify(
              req.method === "pm_getPaymasterData"
                ? {
                    ...req,
                    params: [
                      {
                        ...object(req.params[0]),
                        signature: simple7702SimulationSignature,
                      },
                      ...req.params.slice(1),
                    ],
                  }
                : req,
            ),
            signal: AbortSignal.timeout(12000),
            redirect: "error",
          },
        );
        if (!response.ok || !response.body) throw new Error("Unavailable");
        const reader = response.body.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const n = await reader.read();
            if (n.done) break;
            size += n.value.length;
            if (size > 262144) {
              await reader.cancel();
              throw new Error("Too large");
            }
            chunks.push(n.value);
          }
        } finally {
          reader.releaseLock();
        }
        const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (
          body.jsonrpc !== "2.0" ||
          body.id !== req.id ||
          body.error ||
          !("result" in body)
        )
          throw new Error("Provider rejected");
        const result = body.result;
        if (req.method === "eth_supportedEntryPoints") {
          if (
            !Array.isArray(result) ||
            result.length > 8 ||
            !result.every(
              (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v),
            ) ||
            !result.some((v) => same(v, entryPoint08Address))
          )
            throw new Error("Unsupported entry point");
          return { jsonrpc: "2.0", id: req.id, result: [entryPoint08Address] };
        }
        if (req.method === "pm_getPaymasterData") {
          const r = z
            .object({
              paymaster: address,
              paymasterData: bytes(4096),
              paymasterPostOpGasLimit: qty.optional(),
              paymasterVerificationGasLimit: qty.optional(),
              isFinal: z.literal(true).optional(),
            })
            .strict()
            .parse(result);
          const { isFinal, ...returned } = r;
          const original = opSchema.parse(req.params[0]);
          // EIP-7677 final data may omit gas limits. Keep the already estimated limits,
          // as the SDK does, then validate the complete final operation before returning it.
          const sponsorship = {
            ...returned,
            paymasterPostOpGasLimit:
              returned.paymasterPostOpGasLimit ??
              original.paymasterPostOpGasLimit,
            paymasterVerificationGasLimit:
              returned.paymasterVerificationGasLimit ??
              original.paymasterVerificationGasLimit,
          };
          await this.validateOperation(
            { ...object(req.params[0]), ...sponsorship, signature: "0x" },
            chain as 143 | 4663,
            false,
          );
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              ...sponsorship,
              ...(isFinal === undefined ? {} : { isFinal }),
            },
          };
        }
        if (req.method === "eth_sendUserOperation") {
          hash.parse(result);
          const op = await this.validateOperation(
            req.params[0],
            chain as 143 | 4663,
            true,
          );
          if (
            !same(
              result as string,
              getUserOperationHash({
                chainId: chain,
                entryPointAddress: entryPoint08Address,
                entryPointVersion: "0.8",
                userOperation: op,
              }),
            )
          )
            throw new Error("Hash mismatch");
        } else if (result !== null) {
          if (req.method === "eth_getUserOperationReceipt") {
            const r = userReceiptSchema.parse(result);
            if (
              !same(r.userOpHash, req.params[0] as string) ||
              !same(r.entryPoint, entryPoint08Address) ||
              (r.paymaster && !same(r.paymaster, tokenPaymaster))
            )
              throw new Error("Receipt mismatch");
            return { jsonrpc: "2.0", id: req.id, result: r };
          }
          const r = byHashSchema.parse(normalizeHistoricalOperation(result));
          if (!same(r.entryPoint, entryPoint08Address))
            throw new Error("Entry point mismatch");
          const historical = await this.validateOperation(
            r.userOperation,
            chain as 143 | 4663,
            true,
            true,
          );
          if (
            !same(
              getUserOperationHash({
                chainId: chain,
                entryPointAddress: entryPoint08Address,
                entryPointVersion: "0.8",
                userOperation: historical,
              }),
              req.params[0] as string,
            )
          )
            throw new Error("Historical hash mismatch");
          return { jsonrpc: "2.0", id: req.id, result: r };
        }
        return { jsonrpc: "2.0", id: req.id, result };
      } catch {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message: "Bundler unavailable." },
        };
      }
    })();
  }
}
