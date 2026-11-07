import { CoordinationError } from "./operation-coordinator.ts";
import { qualifyAuroraFees, type AuroraFeeProof } from "./fee-policy.ts";
import { z } from "zod";
import {
  distributionSchema,
  payoutLegSchema,
  validDistributionLeg,
  distributionAmount,
  type Distribution,
  type PayoutLeg,
} from "./distribution.ts";
import { EarnRecoveryEnvelope } from "./recovery-envelope.ts";
import { base58 } from "@scure/base";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  toHex,
  bytesToHex,
  verifyMessage,
  parseEventLogs,
} from "viem";
import type { Address, Hex } from "viem";
import { mainnet } from "viem/chains";
import { ConfidentialSettlement } from "../aurora/settlement.ts";
import { authenticateEarnRead } from "../aurora/confidential-balance.ts";
import { auroraApi } from "../aurora/http.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../aurora/assets.ts";
import { monadUsdc } from "../pimlico/source-funding.ts";
import { ROBINHOOD_PROFILE, robinhoodChain } from "./robinhood-vault.ts";
import {
  NativeGatewayError,
  parseAuroraFeeQualification,
} from "./native-gateway.ts";
import type {
  NativeGatewayConfiguration,
  AuroraFeeQualification,
} from "./native-gateway.ts";
const addr = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((v) => !/^0x0{40}$/i.test(v))
  .transform((v) => getAddress(v));
const atoms = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const id = z.string().regex(/^[-a-zA-Z0-9_]{1,128}$/),
  rev = z.number().int().positive().max(2147483647),
  hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const auth = z
  .object({
    standard: z.literal("erc191"),
    payload: z.string().min(1).max(4096),
    signature: z.string().regex(/^secp256k1:[1-9A-HJ-NP-Za-km-z]{86,90}$/),
  })
  .strict();
const recoveryEnvelope = z.string().min(1).max(180000);
const source = z
  .object({
    operationId: id,
    revision: rev,
    quoteId: hash,
    depositAddress: addr,
    sourceOwner: addr,
    confidentialAccount: addr,
    originAsset: z.literal(monadUsdcAssetId),
    amountAtoms: atoms,
    minimumCreditAtoms: atoms,
    transactionHash: hash,
    maximumCreditAtoms: atoms.optional(),
    baselineEnvelope: z.string().min(1).max(16384).optional(),
    quoteEnvelope: z.string().min(1).max(65536).optional(),
    settlementEnvelope: z.string().min(1).max(131072).optional(),
  })
  .strict();
const payoutPrepareBase = z
  .object({
    operationId: id,
    revision: rev,
    profileChainId: z.union([z.literal(1), z.literal(4663)]),
    leg: payoutLegSchema,
    distribution: distributionSchema.optional(),
    recipient: addr,
    sourceAccountIndex: z.number().int().min(0).max(2147483647).default(0),
    cycleIndex: z.number().int().min(0).max(715827881).default(0),
    splitOffsetAtoms: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/)
      .refine((v) => BigInt(v) < 1n << 256n)
      .default("0"),
    signedData: auth,
    source,
    recoveryEnvelope: recoveryEnvelope.optional(),
    replaceExpiredUnsigned: z.boolean().optional(),
  })
  .strict();
const payoutSubmitBase = z
  .object({
    operationId: id,
    revision: rev,
    leg: payoutLegSchema,
    distribution: distributionSchema.optional(),
    quoteId: hash,
    signedData: auth,
    recoveryEnvelope: recoveryEnvelope.optional(),
  })
  .strict();
const payoutSettlementBase = z
  .object({
    operationId: id,
    revision: rev,
    leg: payoutLegSchema,
    distribution: distributionSchema.optional(),
    quoteId: hash,
    signedData: auth,
    destinationTransactionHash: hash.optional(),
    submittedIntent: auth.optional(),
    recoveryEnvelope: recoveryEnvelope.optional(),
  })
  .strict();
export const payoutPrepareInput =
  payoutPrepareBase.refine(validDistributionLeg);
export const payoutSubmitInput = payoutSubmitBase.refine(validDistributionLeg);
export const payoutSettlementInput =
  payoutSettlementBase.refine(validDistributionLeg);
const returnedSource = source
  .extend({
    routeKind: z.enum(["returnUsdc", "returnEth", "hoodTokenReturn"]),
    originAsset: z.enum([
      ethereumUsdcAssetId,
      "nep141:eth.omft.near",
      robinhoodUsdgAssetId,
    ]),
  })
  .strict();
export const withdrawalPrepareInput = payoutPrepareBase
  .omit({ leg: true, source: true, distribution: true })
  .extend({
    cycleIndex: z.number().int().min(0).max(715827881),
    source: returnedSource,
    distribution: z.undefined().optional(),
  })
  .strict();
const internalWithdrawalPrepare = withdrawalPrepareInput.extend({
  leg: z.literal("withdrawal"),
});
const internalPrepareInput = z.union([
  payoutPrepareInput,
  internalWithdrawalPrepare,
]);
export const withdrawalSubmitInput = payoutSubmitBase.extend({
  distribution: z.undefined().optional(),
  leg: z.literal("withdrawal"),
});
export const withdrawalSettlementInput = payoutSettlementBase.extend({
  distribution: z.undefined().optional(),
  leg: z.literal("withdrawal"),
});
const internalSubmitInput = z.union([payoutSubmitInput, withdrawalSubmitInput]);
const internalSettlementInput = z.union([
  payoutSettlementInput,
  withdrawalSettlementInput,
]);
export type WithdrawalPrepareInput = z.input<typeof withdrawalPrepareInput>;
export type WithdrawalSubmitInput = z.input<typeof withdrawalSubmitInput>;
export type WithdrawalSettlementInput = z.input<
  typeof withdrawalSettlementInput
>;

export type PayoutPrepareInput = z.input<typeof payoutPrepareInput>;
export type PayoutSubmitInput = z.input<typeof payoutSubmitInput>;
export type PayoutSettlementInput = z.input<typeof payoutSettlementInput>;
export interface PrivatePayoutConfiguration extends NativeGatewayConfiguration {
  ethereumRpcUrl?: string;
  monadRpcUrl?: string;
  robinhoodRpcUrl?: string;
  recoveryKey?: string;
}
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid provider body");
  return v as Record<string, unknown>;
}
function date(v: unknown): number {
  if (typeof v !== "string") throw new Error("Missing deadline");
  const n = Date.parse(v);
  if (!Number.isSafeInteger(n) || new Date(n).toISOString() !== v)
    throw new Error("Noncanonical deadline");
  return n;
}
function digest(value: unknown): Hex {
  return keccak256(toHex(JSON.stringify(value)));
}
function decimal(v: unknown): bigint {
  if (
    typeof v !== "string" ||
    v.length > 90 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(v)
  )
    throw new Error("Invalid destination quantity");
  const [w, f = ""] = v.split(".");
  const n = BigInt(w + f.padEnd(6, "0"));
  if (n >= 1n << 256n) throw new Error("Destination quantity overflow");
  return n;
}
function nullable(v: unknown) {
  return v === undefined || v === null;
}
function intentHash(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(v) ||
    base58.decode(v).length !== 32
  )
    throw new Error("Invalid intent hash");
  return v;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Detect duplicate JSON keys without changing the bytes that C must sign. */
function strictJson(payload: string): Record<string, unknown> {
  const parsed = object(JSON.parse(payload));
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (/\s/.test(payload[i] ?? "") && i < payload.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < payload.length) {
      if (payload[i] === "\\") {
        i += 2;
        continue;
      }
      if (payload[i++] === '"')
        return JSON.parse(payload.slice(start, i)) as string;
    }
    throw new Error("Bad string");
  };
  const value = (depth: number): void => {
    if (++nodes > 256 || depth > 8) throw new Error("Payload too complex");
    ws();
    if (payload[i] === "{") {
      i++;
      ws();
      const keys = new Set<string>();
      if (payload[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        if (payload[i] !== '"') throw new Error("Bad object");
        const k = string();
        if (keys.has(k)) throw new Error("Duplicate key");
        keys.add(k);
        ws();
        if (payload[i++] !== ":") throw new Error("Bad key");
        value(depth + 1);
        ws();
        const end = payload[i++];
        if (end === "}") return;
        if (end !== ",") throw new Error("Bad object");
        ws();
      }
    }
    if (payload[i] === "[") {
      i++;
      ws();
      if (payload[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        ws();
        const end = payload[i++];
        if (end === "]") return;
        if (end !== ",") throw new Error("Bad array");
      }
    }
    if (payload[i] === '"') {
      string();
      return;
    }
    while (i < payload.length && !/[\s,}\]]/.test(payload[i]!)) i++;
  };
  value(0);
  ws();
  if (i !== payload.length) throw new Error("Bad trailing data");
  return parsed;
}
const messageSchema = z
  .object({
    signer_id: z.string().regex(/^0x[0-9a-f]{40}$/),
    verifying_contract: z.literal("intents.far"),
    nonce: z.string().max(48),
    deadline: z.string(),
    intents: z.tuple([
      z
        .object({
          intent: z.literal("transfer"),
          receiver_id: z.string().min(1).max(256),
          tokens: z.record(z.string(), atoms),
        })
        .strict(),
    ]),
  })
  .strict();
/** Validate one exact private debit without changing the bytes reserved for signing. */
export function validatePrivatePayoutIntent(
  payload: string,
  expected: { signer: string; depositId: string; amountAtoms: string },
): { deadlineMs: number; nonce: string } {
  z.string().min(1).max(4096).parse(payload);
  const message = messageSchema.parse(strictJson(payload)),
    transfer = message.intents[0],
    tokens = Object.keys(transfer.tokens),
    token = tokens[0],
    nonce = Buffer.from(message.nonce, "base64");
  if (
    tokens.length !== 1 ||
    !token ||
    !token.startsWith("imt:") ||
    /^imt:0{64}:/.test(token) ||
    !token.endsWith(":" + monadUsdcAssetId) ||
    !/^[0-9a-f]{64}$/.test(token.slice(4, -monadUsdcAssetId.length - 1)) ||
    transfer.tokens[token] !== expected.amountAtoms ||
    !same(message.signer_id, expected.signer) ||
    transfer.receiver_id !== expected.depositId ||
    nonce.length !== 32 ||
    nonce.toString("base64") !== message.nonce
  )
    throw Error("Generated private funding intent changed");
  return { deadlineMs: date(message.deadline), nonce: message.nonce };
}
/** Fresh provider-generated unsigned payload only. Signed/recovered retries never call this. */
export function boundUnsignedPayoutDeadline(
  payload: string,
  quoteExpiryMs: number,
  nowMs: number,
): string {
  z.string().min(1).max(4096).parse(payload);
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(quoteExpiryMs) ||
    quoteExpiryMs <= nowMs + 15000 ||
    quoteExpiryMs > nowMs + 600000
  )
    throw Error("Invalid unsigned payout expiry");
  const message = messageSchema.parse(strictJson(payload)),
    originalDeadline = date(message.deadline);
  if (originalDeadline <= nowMs + 15000)
    throw Error("Expired unsigned payout message");
  const boundedDeadline = Math.min(originalDeadline, quoteExpiryMs);
  if (boundedDeadline === originalDeadline) return payload;
  // Serialization occurs before the native review/hash/journal reservation. Only the
  // signer deadline changes; provider nonce and every parsed transfer field remain exact.
  return JSON.stringify({
    ...message,
    deadline: new Date(boundedDeadline).toISOString(),
  });
}
export interface PayoutCreditProof {
  operationId: string;
  revision: number;
  profileChainId: 1 | 4663;
  sourceQuoteId: string;
  sourceTransactionHash: string;
  sourceHistoryId: Hex;
  confidentialAccount: Address;
  sourceOwner: Address;
  sourceAssetId: string;
  sourceToken: Address;
  sourceChainId: 143 | 1 | 4663;
  sourceDecimals: 6 | 18;
  creditedAtoms: string;
  privateTokenId: string;
  observedAtMs: number;
  expiresAtMs: number;
  authenticatedBodyHash: Hex;
}
export interface PayoutQuoteBinding {
  operationId: string;
  revision: number;
  profileChainId: 1 | 4663;
  leg: PayoutLeg | "withdrawal";
  distribution?: Distribution;
  quoteId: Hex;
  depositId: string;
  confidentialAccount: Address;
  refundAccount: Address;
  sourceQuoteId: string;
  sourceTransactionHash: string;
  sourceHistoryId: Hex;
  sourceCreditBodyHash: Hex;
  sourceAssetId: string;
  privateTokenId: string;
  amountAtoms: string;
  destinationChainId: 1 | 143 | 4663;
  destinationAsset: string;
  destinationToken: Address;
  destinationRecipient: Address;
  minimumDestinationAtoms: string;
  maximumDestinationAtoms?: string;
  deadlineMs: number;
  observedAtMs: number;
  quoteCreatedAtMs: number;
  expiresAtMs: number;
  authenticatedBodyHash: Hex;
  payloadHash: Hex;
  feeBps: number;
  feePolicy?: AuroraFeeProof;
  integratorFeeBps: 0;
  applicationFeeAtoms: "0";
  swapType: "EXACT_INPUT";
  confidentiality: "advanced";
  depositType: "CONFIDENTIAL_INTENTS";
  recipientType: "DESTINATION_CHAIN";
  refundType: "CONFIDENTIAL_INTENTS";
  referenceBlock: string;
  referenceHash: Hex;
  initialDestinationAtoms: string;
}
export interface PreparedPrivatePayout {
  recoveryEnvelope: string;
  sourceCredit: PayoutCreditProof;
  quote: PayoutQuoteBinding;
  intent: { standard: "erc191"; payload: string };
  nativeJournalRequired: true;
  nonceVerification: "provider-generated-journal-uniqueness-required";
  executionAvailable: true;
  status: "awaitingNativeAuthorization";
}
type PayoutSourceRequest = z.output<typeof sourceRequestSchema>;
const omitRead = {
  signedData: true,
  recoveryEnvelope: true,
  replaceExpiredUnsigned: true,
} as const;
const sourceRequestSchema = z.union([
  payoutPrepareBase.omit(omitRead).refine(validDistributionLeg),
  internalWithdrawalPrepare.omit(omitRead),
]);
function sourceRequest(
  i: z.output<typeof internalPrepareInput>,
): PayoutSourceRequest {
  const {
    signedData: _auth,
    recoveryEnvelope: _envelope,
    replaceExpiredUnsigned: _replace,
    ...request
  } = i;
  return sourceRequestSchema.parse(request);
}
interface RecordEntry {
  request: PayoutSourceRequest;
  restored?: boolean;
  prepared: PreparedPrivatePayout;
  fingerprint: string;
  retireAt: number;
  signedHash?: Hex;
  submission?: Promise<PayoutSubmission>;
  outcome?: PayoutSubmission;
}
export interface PayoutSubmission {
  operationId: string;
  revision: number;
  leg: PayoutLeg | "withdrawal";
  distribution?: Distribution;
  quoteId: Hex;
  status: "submitted" | "submissionUnknown";
  intentHash?: string;
  signedBodyHash: Hex;
}
/** Provider nonce replay protection and durable native first-seen/role guards are
 * required. The backend never claims to know private on-chain nonce state. */
export class PrivatePayoutGateway {
  private recovery: EarnRecoveryEnvelope;
  private fetcher: typeof fetch;
  private now: () => number;
  private settlement: ConfidentialSettlement;
  private fees?: AuroraFeeQualification;
  private active = 0;
  private records = new Map<string, RecordEntry>();
  private roles = new Map<string, { key: string; fingerprint: string }>();
  private pending = new Map<
    string,
    { fingerprint: string; promise: Promise<PreparedPrivatePayout> }
  >();
  private cycles = new Map<
    string,
    { fingerprint: string; creditedAtoms: string }
  >();
  private rates = new Map<string, { started: number; count: number }>();
  private prune() {
    // Provider work is bounded; keep all associations while preparation or a
    // submission is in flight. Native envelopes and PG commitments outlive caches.
    if(this.active>0||this.pending.size>0)return;
    for(const [key,entry] of this.records)if(entry.retireAt<=this.now())this.records.delete(key);
    for(const [role,row] of this.roles)if(!this.records.has(row.key))this.roles.delete(role);
    const scopes=new Set<string>(),nonces=new Set<string>();
    for(const entry of this.records.values()){
      const source=entry.request.source;
      scopes.add([source.confidentialAccount,source.depositAddress,source.transactionHash].map(v=>v.toLowerCase()).join(":"));
      const message=messageSchema.parse(strictJson(entry.prepared.intent.payload));
      nonces.add(source.confidentialAccount.toLowerCase()+":"+message.nonce);
    }
    for(const scope of this.cycles.keys())if(!scopes.has(scope))this.cycles.delete(scope);
    this.nonces=nonces;
  }
  private checkRate(client: string, distribution?: Distribution) {
    this.prune();
    for (const [key, row] of this.rates)
      if (row.started + 60000 <= this.now()) this.rates.delete(key);
    // Only schema-validated distribution requests reach this method. Five independently
    // quoted/submitted/reconciled slots need up to five legacy request budgets; both
    // namespaces retain the same one-minute window and shared 512-entry capacity bound.
    const maximum = distribution ? 150 : 30;
    const key = `${distribution ? "distribution" : "legacy"}:${client.slice(0, 128)}`,
      row = this.rates.get(key);
    if ((row && row.count >= maximum) || (!row && this.rates.size >= 512))
      throw new NativeGatewayError(429, "EARN_PAYOUT_RATE_LIMIT");
    this.rates.set(
      key,
      row
        ? { ...row, count: row.count + 1 }
        : { started: this.now(), count: 1 },
    );
  }
  private nonces = new Set<string>();
  constructor(
    private config: PrivatePayoutConfiguration = {},
    deps: { fetcher?: typeof fetch; now?: () => number } = {},
  ) {
    this.recovery = new EarnRecoveryEnvelope(config.recoveryKey);
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
    this.settlement = new ConfidentialSettlement(
      config.auroraApiKey,
      this.fetcher,
      this.now,
      config.recoveryKey,
    );
    this.fees = config.auroraFeeQualification
      ? parseAuroraFeeQualification(
          JSON.stringify(config.auroraFeeQualification),
        )
      : undefined;
  }
  private seal(
    prepared:
      Omit<PreparedPrivatePayout, "recoveryEnvelope"> | PreparedPrivatePayout,
    request: PayoutSourceRequest,
  ): PreparedPrivatePayout {
    const { recoveryEnvelope: _old, ...unsigned } =
      prepared as PreparedPrivatePayout;
    return freeze({
      ...unsigned,
      recoveryEnvelope: this.recovery.seal("private-payout", {
        version: 1,
        request,
        prepared: unsigned,
      }),
    });
  }
  private restore(
    token: string,
    identity: {
      operationId: string;
      revision: number;
      leg: string;
      quoteId?: string;
      distribution?: Distribution;
    },
  ): RecordEntry {
    try {
      const body = object(this.recovery.open("private-payout", token));
      if (
        body.version !== 1 ||
        Object.keys(body).sort().join(",") !== "prepared,request,version"
      )
        throw new Error("Invalid recovery body");
      const request = sourceRequestSchema.parse(body.request);
      const unsigned = object(body.prepared) as unknown as Omit<
        PreparedPrivatePayout,
        "recoveryEnvelope"
      >;
      const q = unsigned.quote,
        c = unsigned.sourceCredit;
      const message = messageSchema.parse(strictJson(unsigned.intent.payload));
      if (
        request.operationId !== identity.operationId ||
        request.revision !== identity.revision ||
        request.leg !== identity.leg ||
        q.operationId !== request.operationId ||
        q.revision !== request.revision ||
        q.leg !== request.leg ||
        JSON.stringify(request.distribution) !==
          JSON.stringify(identity.distribution) ||
        JSON.stringify(q.distribution) !==
          JSON.stringify(request.distribution) ||
        q.profileChainId !== request.profileChainId ||
        !same(q.confidentialAccount, request.source.confidentialAccount) ||
        !same(q.destinationRecipient, request.recipient) ||
        (identity.quoteId && !same(q.quoteId, identity.quoteId)) ||
        c.operationId !== request.source.operationId ||
        c.revision !== request.source.revision ||
        !same(c.sourceTransactionHash, request.source.transactionHash) ||
        !same(c.sourceQuoteId, request.source.quoteId) ||
        !same(message.signer_id, q.confidentialAccount) ||
        message.intents[0].receiver_id !== q.depositId ||
        keccak256(toHex(unsigned.intent.payload)) !== q.payloadHash ||
        date(message.deadline) !== q.deadlineMs
      )
        throw new Error("Changed recovery identity");
      if (
        c.sourceOwner !== undefined &&
        !same(c.sourceOwner, request.source.sourceOwner)
      )
        throw new Error("Changed recovered source owner");
      const prepared = freeze({
        ...unsigned,
        sourceCredit: { ...c, sourceOwner: request.source.sourceOwner },
        recoveryEnvelope: token,
      });
      const fingerprint = JSON.stringify(request),
        key = this.key(request);
      const current = this.records.get(key);
      if (current) {
        if (
          current.fingerprint !== fingerprint ||
          current.prepared.quote.quoteId !== q.quoteId
        )
          throw new Error("Conflicting restored payout");
        return current;
      }
      if (this.records.size >= 512) throw new Error("Recovery capacity");
      const fundingScope = [
        request.source.confidentialAccount,
        request.source.depositAddress,
        request.source.transactionHash,
      ]
        .map((v) => v.toLowerCase())
        .join(":");
      const role = `${fundingScope}:${request.leg}`,
        prior = this.roles.get(role);
      if (prior && (prior.key !== key || prior.fingerprint !== fingerprint))
        throw new Error("Conflicting restored role");
      const entry: RecordEntry = {
        prepared,
        request,
        fingerprint,
        retireAt: this.now() + 86400000,
        restored: true,
      };
      const cycleFingerprint = JSON.stringify({
          source: request.source,
          profileChainId: request.profileChainId,
          sourceAccountIndex: request.sourceAccountIndex,
          cycleIndex: request.cycleIndex,
          splitOffsetAtoms: request.splitOffsetAtoms,
          distribution: request.distribution,
        }),
        cycle = this.cycles.get(fundingScope);
      if (
        cycle &&
        (cycle.fingerprint !== cycleFingerprint ||
          cycle.creditedAtoms !== c.creditedAtoms)
      )
        throw new Error("Conflicting recovered credit");
      this.cycles.set(fundingScope, {
        fingerprint: cycleFingerprint,
        creditedAtoms: c.creditedAtoms,
      });
      this.roles.set(role, { key, fingerprint });
      this.records.set(key, entry);
      this.nonces.add(
        request.source.confidentialAccount.toLowerCase() + ":" + message.nonce,
      );
      return entry;
    } catch {
      throw new NativeGatewayError(409, "EARN_PAYOUT_RECOVERY_INVALID");
    }
  }
  private key(i: { operationId: string; revision: number; leg: string }) {
    return `${i.operationId}:${i.revision}:${i.leg}`;
  }
  private client(chain: 1 | 143 | 4663) {
    const url =
      chain === 143
        ? (this.config.monadRpcUrl ?? "https://rpc.monad.xyz")
        : chain === 1
          ? this.config.ethereumRpcUrl
          : this.config.robinhoodRpcUrl;
    if (!url) throw new NativeGatewayError(503, "EARN_PAYOUT_RPC_UNCONFIGURED");
    return createPublicClient({
      chain:
        chain === 143
          ? defineChain({
              id: 143,
              name: "Monad Mainnet",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: { default: { http: [url] } },
            })
          : chain === 1
            ? mainnet
            : robinhoodChain,
      transport: http(url, {
        fetchFn: this.fetcher,
        timeout: 12000,
        retryCount: 0,
      }),
      cacheTime: 0,
    });
  }
  private async bounded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= 4) throw new NativeGatewayError(429, "EARN_PAYOUT_BUSY");
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
  async prepare(
    value: PayoutPrepareInput,
    client = "internal",
  ): Promise<PreparedPrivatePayout> {
    let input: z.output<typeof payoutPrepareInput>;
    try {
      input = payoutPrepareInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_PAYOUT_REQUEST");
    }
    return this.prepareRequest(input, client);
  }
  async prepareWithdrawal(value: WithdrawalPrepareInput, client = "internal") {
    let input: z.output<typeof withdrawalPrepareInput>;
    try {
      input = withdrawalPrepareInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_WITHDRAWAL_REQUEST");
    }
    const expectedAsset =
      input.source.routeKind === "returnEth"
        ? "nep141:eth.omft.near"
        : input.source.routeKind === "returnUsdc"
          ? ethereumUsdcAssetId
          : robinhoodUsdgAssetId;
    if (
      input.splitOffsetAtoms !== "0" ||
      input.source.originAsset !== expectedAsset ||
      (input.source.routeKind === "hoodTokenReturn"
        ? input.profileChainId !== 4663
        : input.profileChainId !== 1) ||
      input.operationId === input.source.operationId
    )
      throw new NativeGatewayError(400, "INVALID_WITHDRAWAL_RETURN");
    const prepared = await this.prepareRequest(
      { ...input, leg: "withdrawal" },
      client,
    );
    return freeze({
      ...prepared,
      sourceCredit: {
        returnOperationId: input.source.operationId,
        credit: {
          ...prepared.sourceCredit,
          operationId: input.operationId,
          revision: input.revision,
        },
      },
      quote: { destinationChainId: 143 as const, quote: prepared.quote },
    });
  }
  private async prepareRequest(
    i: z.output<typeof internalPrepareInput>,
    client: string,
  ): Promise<PreparedPrivatePayout> {
    this.checkRate(client, i.distribution);
    if (!this.recovery.configured)
      throw new NativeGatewayError(503, "EARN_PAYOUT_RECOVERY_UNCONFIGURED");
    if (!this.config.auroraApiKey || !this.fees)
      throw new NativeGatewayError(503, "EARN_AURORA_FEE_UNQUALIFIED");
    // One current-leg recipient only; native role derivation guards sibling identity.
    if (
      same(i.recipient, i.source.confidentialAccount) ||
      ((i.leg === "invest" || i.distribution) &&
        same(i.recipient, i.source.sourceOwner))
    )
      throw new NativeGatewayError(400, "INVALID_PAYOUT_IDENTITIES");
    if (
      i.leg !== "withdrawal" &&
      (i.operationId !== i.source.operationId ||
        i.revision !== i.source.revision)
    )
      throw new NativeGatewayError(400, "INVALID_PAYOUT_FUNDING_OPERATION");
    const fundingScope = [
      i.source.confidentialAccount,
      i.source.depositAddress,
      i.source.transactionHash,
    ]
      .map((v) => v.toLowerCase())
      .join(":");
    const cycleFingerprint = JSON.stringify({
      source: i.source,
      profileChainId: i.profileChainId,
      sourceAccountIndex: i.sourceAccountIndex,
      cycleIndex: i.cycleIndex,
      splitOffsetAtoms: i.splitOffsetAtoms,
      distribution: i.distribution,
    });
    const cycle = this.cycles.get(fundingScope);
    if (cycle && cycle.fingerprint !== cycleFingerprint)
      throw new NativeGatewayError(409, "EARN_PAYOUT_CREDIT_BOUND");
    const key = this.key(i),
      role = `${fundingScope}:${i.leg}`,
      fingerprint = JSON.stringify(sourceRequest(i));
    if (i.recoveryEnvelope) this.restore(i.recoveryEnvelope, i);
    const existingRole = this.roles.get(role);
    if (
      existingRole &&
      (existingRole.key !== key || existingRole.fingerprint !== fingerprint)
    )
      throw new NativeGatewayError(409, "EARN_PAYOUT_ROLE_BOUND");
    let existing = this.records.get(key);
    if (existing) {
      if (existing.signedHash)
        throw new NativeGatewayError(409, "EARN_PAYOUT_ALREADY_AUTHORIZED");
      if (existing.fingerprint !== fingerprint)
        throw new NativeGatewayError(409, "EARN_PAYOUT_BINDING_CHANGED");
      if (existing.prepared.quote.expiresAtMs <= this.now()) {
        if (!i.replaceExpiredUnsigned || !i.recoveryEnvelope)
          throw new NativeGatewayError(409, "EARN_PAYOUT_BINDING_CHANGED");
        this.records.delete(key);
        existing = undefined;
      }
    }
    if (existing) {
      try {
        const { quoteId, ...expectation } = i.source;
        const fresh = await this.settlement.read(i.signedData, expectation, true);
        if (
          fresh.status !== "credited" ||
          fresh.creditedAtoms !== existing.prepared.sourceCredit.creditedAtoms
        )
          throw new Error("Changed confirmed credit");
        const sourceCredit = {
          ...existing.prepared.sourceCredit,
          observedAtMs: this.now(),
          expiresAtMs: this.now() + 60000,
          authenticatedBodyHash: digest(fresh),
        };
        const quote = {
          ...existing.prepared.quote,
          observedAtMs: this.now(),
          sourceCreditBodyHash: sourceCredit.authenticatedBodyHash,
        };
        existing.prepared = this.seal(
          { ...existing.prepared, sourceCredit, quote },
          existing.request,
        );
        return existing.prepared;
      } catch {
        throw new NativeGatewayError(502, "EARN_PRIVATE_PAYOUT_UNAVAILABLE");
      }
    }
    const waiting = this.pending.get(key);
    if (waiting) {
      if (waiting.fingerprint !== fingerprint)
        throw new NativeGatewayError(409, "EARN_PAYOUT_BINDING_CHANGED");
      return waiting.promise;
    }
    if (this.records.size + this.pending.size >= 512)
      throw new NativeGatewayError(503, "EARN_PAYOUT_CAPACITY");
    this.roles.set(role, {key,fingerprint});
    const promise = this.bounded(async () => {
      try {
        const { quoteId: sourceQuoteId, ...expectation } = i.source;
        const verified = await this.settlement.read(i.signedData, expectation, true);
        if (
          verified.status !== "credited" ||
          BigInt(verified.creditedAtoms) <
            (i.leg === "withdrawal" || i.distribution ? 1n : 10n)
        )
          throw new Error("Actual source credit required");
        await this.config.coordination?.bind("payout-role", role, {key,fingerprint}, this.now()+86400000);
        const settledCycle = this.cycles.get(fundingScope);
        if (
          settledCycle &&
          (settledCycle.fingerprint !== cycleFingerprint ||
            settledCycle.creditedAtoms !== verified.creditedAtoms)
        )
          throw new NativeGatewayError(409, "EARN_PAYOUT_CREDIT_BOUND");
        if (!settledCycle && this.cycles.size >= 512)
          throw new NativeGatewayError(503, "EARN_PAYOUT_CAPACITY");
        await this.config.coordination?.bind("payout-credit",fundingScope,{fingerprint:cycleFingerprint,creditedAtoms:verified.creditedAtoms},this.now()+86400000);
        this.cycles.set(fundingScope, {
          fingerprint: cycleFingerprint,
          creditedAtoms: verified.creditedAtoms,
        });
        const credited = BigInt(verified.creditedAtoms),
          offset = BigInt(i.splitOffsetAtoms),
          hold = (offset + credited) / 10n - offset / 10n,
          amount = i.distribution
            ? distributionAmount(i.distribution, i.leg, offset, credited)
            : i.leg === "withdrawal"
              ? credited
              : i.leg === "hold"
                ? hold
                : credited - hold;
        const recipient = i.recipient,
          token =
            i.leg === "withdrawal"
              ? monadUsdc
              : i.profileChainId === 1
                ? getAddress("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
                : ROBINHOOD_PROFILE.token,
          destinationAsset =
            i.leg === "withdrawal"
              ? monadUsdcAssetId
              : i.profileChainId === 1
                ? ethereumUsdcAssetId
                : robinhoodUsdgAssetId;
        const destinationChainId =
          i.leg === "withdrawal" ? 143 : i.profileChainId;
        const client = this.client(destinationChainId);
        if ((await client.getChainId()) !== destinationChainId)
          throw new Error("Wrong destination chain");
        const block = await client.getBlock();
        if (
          !block.hash ||
          !block.number ||
          this.now() - Number(block.timestamp) * 1000 > 60000 ||
          Number(block.timestamp) * 1000 > this.now() + 5000
        )
          throw new Error("Stale destination reference");
        const [decimals, initial, code] = await Promise.all([
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "decimals",
            blockNumber: block.number,
          }),
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [recipient],
            blockNumber: block.number,
          }),
          client.getCode({ address: token, blockNumber: block.number }),
        ]);
        if (decimals !== 6 || !code || code === "0x")
          throw new Error("Unsupported destination token");
        const observed = this.now(),
          request = {
            dry: false,
            swapType: "EXACT_INPUT",
            depositType: "CONFIDENTIAL_INTENTS",
            depositMode: "SIMPLE",
            confidentiality: "advanced",
            amount: amount.toString(),
            originAsset: monadUsdcAssetId,
            destinationAsset,
            // Robinhood 10/90 payouts are bounded by the 7% preview floor; others keep exact quotes.
            slippageTolerance:
              i.profileChainId === 4663 && i.leg !== "withdrawal" ? 500 : 0,
            refundTo: i.source.confidentialAccount.toLowerCase(),
            refundType: "CONFIDENTIAL_INTENTS",
            recipient: recipient.toLowerCase(),
            recipientType: "DESTINATION_CHAIN",
            deadline: new Date(observed + 600000).toISOString(),
          };
        const body = await auroraApi(
            this.config.auroraApiKey!,
            this.fetcher,
            "quote/{key}",
            request,
          ),
          qr = object(body.quoteRequest),
          q = object(body.quote);
        for (const [k, v] of Object.entries(request))
          if (qr[k] !== v) throw new Error("Changed payout quote");
        let feePolicy: AuroraFeeProof;
        try {
          feePolicy = qualifyAuroraFees(
            this.fees,
            i.leg === "withdrawal"
              ? "withdrawal"
              : i.profileChainId === 1
                ? "payoutEthereum"
                : "payoutRobinhood",
            qr,
          );
        } catch {
          throw new NativeGatewayError(503, "EARN_AURORA_FEE_UNQUALIFIED");
        }
        if (
          typeof body.signature !== "string" ||
          !body.signature ||
          body.signature.length > 4096 ||
          Math.abs(date(body.timestamp) - observed) > 60000
        )
          throw new Error("Unqualified payout quote");
        for (const row of [qr, q])
          for (const field of [
            "depositMemo",
            "chainDepositAddresses",
            "virtualChainRecipient",
            "virtualChainRefundRecipient",
            "customRecipientMsg",
          ])
            if (!nullable(row[field]))
              throw new Error("Additional quote effects");
        if (
          !nullable(qr.connectedWallets) &&
          (!Array.isArray(qr.connectedWallets) || qr.connectedWallets.length)
        )
          throw new Error("Extra connected wallets");
        if (
          typeof q.depositAddress !== "string" ||
          !/^[-a-zA-Z0-9_.:]{1,256}$/.test(q.depositAddress) ||
          q.amountIn !== amount.toString() ||
          q.minAmountIn !== amount.toString()
        )
          throw new Error("Private quote deposit changed");
        const minimum = BigInt(atoms.parse(q.minAmountOut)),
          out = BigInt(atoms.parse(q.amountOut));
        if (minimum > out) throw new Error("Invalid payout minimum");
        const expires = Math.min(
          date(q.deadline),
          date(qr.deadline),
          q.timeWhenInactive === undefined
            ? Infinity
            : date(q.timeWhenInactive),
        );
        if (expires <= this.now() + 15000 || expires > observed + 600000)
          throw new Error("Expired payout quote");
        for (const fee of [q.refundFee, q.withdrawFee])
          if (
            !nullable(fee) &&
            (typeof fee !== "string" ||
              !/^(0|[1-9][0-9]{0,77})$/.test(fee) ||
              BigInt(fee) >= 1n << 256n)
          )
            throw new Error("Invalid provider fee");
        for (const entry of this.records.values())
          if (entry.prepared.quote.depositId === q.depositAddress)
            throw new Error("Reused quote deposit");
        const generated = await auroraApi(
          this.config.auroraApiKey!,
          this.fetcher,
          "generate-intent/{key}",
          {
            type: "swap_transfer",
            standard: "erc191",
            signerId: i.source.confidentialAccount.toLowerCase(),
            depositAddress: q.depositAddress,
          },
        );
        const intent = z
            .object({
              standard: z.literal("erc191"),
              payload: z.string().min(1).max(4096),
            })
            .strict()
            .parse(generated.intent),
          message = messageSchema.parse(strictJson(intent.payload)),
          nonce = Buffer.from(message.nonce, "base64");
        const tokens = Object.keys(message.intents[0].tokens);
        const privateTokenId = tokens[0];
        if (
          tokens.length !== 1 ||
          !privateTokenId ||
          !privateTokenId.startsWith("imt:") ||
          /^imt:0{64}:/.test(privateTokenId) ||
          !privateTokenId.endsWith(":" + monadUsdcAssetId) ||
          !/^[0-9a-f]{64}$/.test(
            privateTokenId.slice(4, -monadUsdcAssetId.length - 1),
          ) ||
          message.intents[0].tokens[privateTokenId] !== amount.toString() ||
          !same(message.signer_id, i.source.confidentialAccount) ||
          message.intents[0].receiver_id !== q.depositAddress ||
          nonce.length !== 32 ||
          nonce.toString("base64") !== message.nonce ||
          date(message.deadline) <= this.now() + 15000
        )
          throw new Error("Generated intent changed");
        // A generator may choose a multi-day default even for a short quote. Reduce
        // fresh unsigned authority only, after all transfer/nonce bindings pass.
        intent.payload = boundUnsignedPayoutDeadline(
          intent.payload,
          expires,
          this.now(),
        );
        message.deadline = messageSchema.parse(
          strictJson(intent.payload),
        ).deadline;
        const nonceKey =
          i.source.confidentialAccount.toLowerCase() + ":" + message.nonce;
        if (this.nonces.has(nonceKey))
          throw new Error("Repeated private nonce");
        await this.config.coordination?.bind("payout-nonce",nonceKey,{key,payload:intent.payload},this.now()+86400000);
        const sourceHistoryId = digest({
          confidentialAccount: verified.confidentialAddress,
          depositAddress: verified.depositAddress,
          transactionHash: verified.transactionHash,
          assetId: verified.assetId,
          creditedAtoms: verified.creditedAtoms,
        });
        for (const row of this.records.values())
          if (
            row.prepared.sourceCredit.sourceHistoryId === sourceHistoryId &&
            row.prepared.quote.privateTokenId !== privateTokenId
          )
            throw new Error("Changed private asset identity");
        const sourceCredit: PayoutCreditProof = {
          operationId: i.source.operationId,
          revision: i.source.revision,
          profileChainId: i.profileChainId,
          sourceQuoteId,
          sourceTransactionHash: i.source.transactionHash,
          sourceHistoryId,
          confidentialAccount: i.source.confidentialAccount,
          sourceOwner: i.source.sourceOwner,
          sourceAssetId: i.source.originAsset,
          sourceToken:
            i.leg === "withdrawal"
              ? i.source.routeKind === "returnEth"
                ? getAddress("0x0000000000000000000000000000000000000000")
                : i.source.routeKind === "returnUsdc"
                  ? getAddress("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
                  : ROBINHOOD_PROFILE.token
              : monadUsdc,
          sourceChainId: i.leg === "withdrawal" ? i.profileChainId : 143,
          sourceDecimals:
            i.leg === "withdrawal" && i.source.routeKind === "returnEth"
              ? 18
              : 6,
          creditedAtoms: verified.creditedAtoms,
          privateTokenId,
          observedAtMs: this.now(),
          expiresAtMs: this.now() + 60000,
          authenticatedBodyHash: digest(verified),
        };
        const quoteId = digest({
          operationId: i.operationId,
          revision: i.revision,
          leg: i.leg,
          splitOffsetAtoms: i.splitOffsetAtoms,
          distribution: i.distribution,
          sourceAccountIndex: i.sourceAccountIndex,
          cycleIndex: i.cycleIndex,
          ...(i.leg === "withdrawal"
            ? {
                returnOperationId: i.source.operationId,
                source: i.source,
              }
            : {}),
          providerBody: body,
          feePolicy,
          payload: intent.payload,
        });
        const quote: PayoutQuoteBinding = {
          operationId: i.operationId,
          revision: i.revision,
          profileChainId: i.profileChainId,
          leg: i.leg,
          ...(i.distribution ? { distribution: i.distribution } : {}),
          quoteId,
          depositId: q.depositAddress,
          confidentialAccount: i.source.confidentialAccount,
          refundAccount: i.source.confidentialAccount,
          sourceQuoteId,
          sourceTransactionHash: i.source.transactionHash,
          sourceHistoryId,
          sourceCreditBodyHash: sourceCredit.authenticatedBodyHash,
          sourceAssetId: i.source.originAsset,
          privateTokenId,
          amountAtoms: amount.toString(),
          destinationChainId,
          destinationAsset,
          destinationToken: token,
          destinationRecipient: recipient,
          minimumDestinationAtoms: minimum.toString(),
          maximumDestinationAtoms: out.toString(),
          deadlineMs: date(message.deadline),
          observedAtMs: this.now(),
          quoteCreatedAtMs: observed,
          expiresAtMs: Math.min(expires, date(message.deadline)),
          authenticatedBodyHash: digest(body),
          payloadHash: keccak256(toHex(intent.payload)),
          feeBps: feePolicy.totalBps,
          feePolicy,
          integratorFeeBps: 0,
          applicationFeeAtoms: "0",
          swapType: "EXACT_INPUT",
          confidentiality: "advanced",
          depositType: "CONFIDENTIAL_INTENTS",
          recipientType: "DESTINATION_CHAIN",
          refundType: "CONFIDENTIAL_INTENTS",
          referenceBlock: block.number.toString(),
          referenceHash: block.hash,
          initialDestinationAtoms: initial.toString(),
        };
        const canonical = await client.getBlock({ blockNumber: block.number });
        if (
          canonical.hash !== block.hash ||
          quote.expiresAtMs <= this.now() + 15000
        )
          throw new Error("Changed payout reference");
        const prepared = this.seal(
          {
            sourceCredit,
            quote,
            intent,
            nativeJournalRequired: true as const,
            nonceVerification:
              "provider-generated-journal-uniqueness-required" as const,
            executionAvailable: true as const,
            status: "awaitingNativeAuthorization" as const,
          },
          sourceRequest(i),
        );
        this.records.set(key, {
          prepared,
          request: sourceRequest(i),
          fingerprint,
          retireAt: this.now() + 86400000,
        });
        this.nonces.add(nonceKey);
        return prepared;
      } catch (error) {
        if (error instanceof NativeGatewayError || error instanceof CoordinationError) throw error;
        throw new NativeGatewayError(502, "EARN_PRIVATE_PAYOUT_UNAVAILABLE");
      }
    });
    this.pending.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
      if (!this.records.has(key)) this.roles.delete(role);
      this.prune();
    }
  }
  private entry(i: {
    operationId: string;
    revision: number;
    leg: string;
    quoteId: string;
    recoveryEnvelope?: string;
    distribution?: Distribution;
  }): RecordEntry {
    if (i.recoveryEnvelope) return this.restore(i.recoveryEnvelope, i);
    const entry = this.records.get(this.key(i));
    if (
      !entry ||
      JSON.stringify(entry.request.distribution) !==
        JSON.stringify(i.distribution) ||
      entry.retireAt <= this.now() ||
      !same(entry.prepared.quote.quoteId, i.quoteId)
    )
      throw new NativeGatewayError(409, "EARN_PAYOUT_UNKNOWN");
    return entry;
  }
  private async verifySignedIntent(
    entry: RecordEntry,
    signedData: z.output<typeof auth>,
  ) {
    const q = entry.prepared.quote;
    try {
      if (signedData.payload !== entry.prepared.intent.payload)
        throw new Error("Changed signed payload");
      const bytes = base58.decode(signedData.signature.slice(10));
      if (bytes.length !== 65 || bytes[64]! > 1)
        throw new Error("Bad signature");
      bytes[64]! += 27;
      if (
        !(await verifyMessage({
          address: q.confidentialAccount,
          message: signedData.payload,
          signature: bytesToHex(bytes),
        }))
      )
        throw new Error("Wrong confidential signer");
    } catch {
      throw new NativeGatewayError(400, "INVALID_SIGNED_PAYOUT");
    }
  }
  async submit(
    value: PayoutSubmitInput,
    client = "internal",
  ): Promise<PayoutSubmission> {
    let input: z.output<typeof payoutSubmitInput>;
    try {
      input = payoutSubmitInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_PAYOUT_SUBMISSION");
    }
    return this.submitRequest(input, client);
  }
  async submitWithdrawal(value: WithdrawalSubmitInput, client = "internal") {
    let input: z.output<typeof withdrawalSubmitInput>;
    try {
      input = withdrawalSubmitInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_WITHDRAWAL_SUBMISSION");
    }
    return this.submitRequest(input, client);
  }
  private async submitRequest(
    i: z.output<typeof internalSubmitInput>,
    client: string,
  ): Promise<PayoutSubmission> {
    this.checkRate(client, i.distribution);
    const entry = this.entry(i),
      q = entry.prepared.quote;
    await this.verifySignedIntent(entry, i.signedData);
    const signedHash = digest(i.signedData);
    if (entry.signedHash && entry.signedHash !== signedHash)
      throw new NativeGatewayError(409, "EARN_SIGNED_PAYOUT_CHANGED");
    if (entry.outcome?.status === "submitted") return entry.outcome;
    if (entry.outcome?.status === "submissionUnknown")
      entry.submission = undefined;
    if (entry.submission) return entry.submission;
    if (q.expiresAtMs <= this.now())
      throw new NativeGatewayError(409, "EARN_PAYOUT_EXPIRED");
    entry.signedHash = signedHash;
    entry.submission = this.bounded(async () => {
      if(this.config.coordination){
        const request=entry.request,key=this.key(request);
        const fundingScope=[request.source.confidentialAccount,request.source.depositAddress,request.source.transactionHash].map(v=>v.toLowerCase()).join(":");
        const role=`${fundingScope}:${request.leg}`,expires=q.expiresAtMs+86400000;
        await this.config.coordination.bind("payout-role",role,{key,fingerprint:entry.fingerprint},expires);
        const cycleFingerprint=JSON.stringify({source:request.source,profileChainId:request.profileChainId,sourceAccountIndex:request.sourceAccountIndex,cycleIndex:request.cycleIndex,splitOffsetAtoms:request.splitOffsetAtoms,distribution:request.distribution});
        await this.config.coordination.bind("payout-credit",fundingScope,{fingerprint:cycleFingerprint,creditedAtoms:entry.prepared.sourceCredit.creditedAtoms},expires);
        if(!await this.config.coordination.claim("payout-send",role,{signedHash},expires))
          return freeze({operationId:i.operationId,revision:i.revision,leg:i.leg,...(q.distribution ? {distribution:q.distribution} : {}),quoteId:q.quoteId,status:"submissionUnknown" as const,signedBodyHash:signedHash});
      }
      let outcome: PayoutSubmission;
      try {
        const result = await auroraApi(
          this.config.auroraApiKey!,
          this.fetcher,
          "submit-intent/{key}",
          { type: "swap_transfer", signedData: i.signedData },
        );
        outcome = {
          operationId: i.operationId,
          revision: i.revision,
          leg: i.leg,
          ...(q.distribution ? { distribution: q.distribution } : {}),
          quoteId: q.quoteId,
          status: "submitted",
          intentHash: intentHash(result.intentHash),
          signedBodyHash: signedHash,
        };
      } catch {
        outcome = {
          operationId: i.operationId,
          revision: i.revision,
          leg: i.leg,
          ...(q.distribution ? { distribution: q.distribution } : {}),
          quoteId: q.quoteId,
          status: "submissionUnknown",
          signedBodyHash: signedHash,
        };
      }
      entry.outcome = freeze(outcome);
      return entry.outcome;
    });
    try { return await entry.submission; }
    catch(error) { entry.submission=undefined; throw error; }
  }
  async reconcile(value: PayoutSettlementInput, client = "internal") {
    let input: z.output<typeof payoutSettlementInput>;
    try {
      input = payoutSettlementInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_PAYOUT_SETTLEMENT");
    }
    return this.reconcileRequest(input, client);
  }
  async reconcileWithdrawal(
    value: WithdrawalSettlementInput,
    client = "internal",
  ) {
    let input: z.output<typeof withdrawalSettlementInput>;
    try {
      input = withdrawalSettlementInput.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_WITHDRAWAL_SETTLEMENT");
    }
    return this.reconcileRequest(input, client);
  }
  private async confirmDestination(
    q: PayoutQuoteBinding,
    transactionHash: string,
    received?: bigint,
  ) {
    const client = this.client(q.destinationChainId);
    if ((await client.getChainId()) !== q.destinationChainId)
      throw new Error("Wrong public chain");
    const receipt = await client.getTransactionReceipt({
      hash: transactionHash as Hex,
    });
    if (
      receipt.status !== "success" ||
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      receipt.blockNumber <= BigInt(q.referenceBlock)
    )
      throw new Error("Unconfirmed destination");
    const [block, finalized, reference] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlock({ blockTag: "finalized" }),
      client.getBlock({ blockNumber: BigInt(q.referenceBlock) }),
    ]);
    // Like Swap, Robinhood payouts count once the exact receipt is canonical; Robinhood's L1
    // finality trails by ~17 minutes. Other destinations keep finalized delivery.
    const awaitFinality = q.destinationChainId !== 4663;
    if (
      block.hash !== receipt.blockHash ||
      reference.hash !== q.referenceHash ||
      (awaitFinality &&
        (finalized.number === null ||
          finalized.number < receipt.blockNumber)) ||
      Number(block.timestamp) * 1000 < q.quoteCreatedAtMs - 1000
    )
      throw new Error("Noncanonical payout");
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs,
      strict: true,
    }).filter(
      (v) =>
        same(v.address, q.destinationToken) &&
        same(v.args.to, q.destinationRecipient),
    );
    if (transfers.length !== 1)
      throw new Error("Exact public payout transfer missing");
    const actual = transfers[0]!.args.value;
    if (
      actual < BigInt(q.minimumDestinationAtoms) ||
      (received !== undefined && actual !== received) ||
      (q.maximumDestinationAtoms && actual > BigInt(q.maximumDestinationAtoms))
    )
      throw new Error("Payout value outside quote bounds");
    const confirmed = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (confirmed.hash !== block.hash) throw new Error("Payout changed");
    return { receipt, block, received: transfers[0]!.args.value };
  }

  private async reconcileWithoutHistory(
    entry: RecordEntry,
    i: z.output<typeof internalSettlementInput>,
  ) {
    const q = entry.prepared.quote;
    if (!i.submittedIntent) throw new Error("Saved signed intent required");
    await this.verifySignedIntent(entry, i.submittedIntent);
    const signedHash = digest(i.submittedIntent);
    if (entry.signedHash && entry.signedHash !== signedHash)
      throw new Error("Signed payout changed");
    entry.signedHash = signedHash;
    const route = await auroraApi(
      this.config.auroraApiKey!,
      this.fetcher,
      `status/{key}?depositAddress=${encodeURIComponent(q.depositId)}`,
    );
    const base = {
      operationId: i.operationId,
      revision: i.revision,
      leg: i.leg,
      ...(q.distribution ? { distribution: q.distribution } : {}),
      quoteId: q.quoteId,
      confidentialAccount: q.confidentialAccount,
      destinationChainId: q.destinationChainId,
      destinationToken: q.destinationToken,
      destinationRecipient: q.destinationRecipient,
      minimumDestinationAtoms: q.minimumDestinationAtoms,
      observedAtMs: this.now(),
      expiresAtMs: this.now() + 60000,
      authenticated: true as const,
      operationScoped: true as const,
      verification: "signed-route-receipt-v1" as const,
    };
    if (route.status !== "SUCCESS") {
      if (
        ![
          "KNOWN_DEPOSIT_TX",
          "PENDING_DEPOSIT",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
        ].includes(String(route.status))
      )
        throw new Error("Payout route failed");
      return {
        ...base,
        status: "awaitingSettlement" as const,
        receivedAtoms: "0",
      };
    }
    if (!i.destinationTransactionHash)
      return {
        ...base,
        status: "awaitingDestinationConfirmation" as const,
        receivedAtoms: "0",
      };
    const { receipt, block, received } = await this.confirmDestination(
      q,
      i.destinationTransactionHash,
    );
    return {
      ...base,
      status: "delivered" as const,
      receivedAtoms: received.toString(),
      destinationTransactionHash: receipt.transactionHash,
      referenceBlock: receipt.blockNumber.toString(),
      referenceHash: receipt.blockHash,
      authenticatedBodyHash: digest({
        signedHash,
        depositId: q.depositId,
        routeStatus: route.status,
        transactionHash: receipt.transactionHash,
        blockHash: block.hash,
        receivedAtoms: received.toString(),
      }),
    };
  }
  private async reconcileRequest(
    i: z.output<typeof internalSettlementInput>,
    client: string,
  ) {
    this.checkRate(client, i.distribution);
    const entry = this.entry(i),
      q = entry.prepared.quote;
    if (!entry.signedHash && !entry.restored)
      throw new NativeGatewayError(409, "EARN_PAYOUT_NOT_SUBMITTED");
    return this.bounded(async () => {
      try {
        const C = await authenticateEarnRead(i.signedData, this.now);
        if (!same(C, q.confidentialAccount))
          throw new Error("Wrong read owner");
        if (entry.request.source.settlementEnvelope)
          return await this.reconcileWithoutHistory(entry, i);
        const session = await auroraApi(
          this.config.auroraApiKey!,
          this.fetcher,
          "auth/authenticate/{key}",
          { signedData: i.signedData },
        );
        if (
          typeof session.accessToken !== "string" ||
          !session.accessToken ||
          session.accessToken.length > 8192
        )
          throw new Error("Invalid session");
        const query = new URLSearchParams({
          depositAddress: q.depositId,
          status: "SUCCESS",
          depositType: "CONFIDENTIAL_INTENTS",
          recipientType: "DESTINATION_CHAIN",
          refundType: "CONFIDENTIAL_INTENTS",
          limit: "100",
        });
        const history = await auroraApi(
          this.config.auroraApiKey!,
          this.fetcher,
          `account/history/{key}?${query}`,
          undefined,
          session.accessToken,
        );
        if (!Array.isArray(history.items) || history.items.length > 100)
          throw new Error("Invalid private history");
        const rows = history.items
          .map(object)
          .filter((v) => v.depositAddress === q.depositId);
        if (rows.length > 1) throw new Error("Ambiguous payout history");
        const row = rows[0];
        const base = {
          operationId: i.operationId,
          revision: i.revision,
          leg: i.leg,
          ...(q.distribution ? { distribution: q.distribution } : {}),
          quoteId: q.quoteId,
          confidentialAccount: q.confidentialAccount,
          destinationChainId: q.destinationChainId,
          destinationToken: q.destinationToken,
          destinationRecipient: q.destinationRecipient,
          minimumDestinationAtoms: q.minimumDestinationAtoms,
          observedAtMs: this.now(),
          expiresAtMs: this.now() + 60000,
          authenticated: true as const,
          operationScoped: true as const,
        };
        if (!row || row.status !== "SUCCESS")
          return {
            ...base,
            status: "awaitingSettlement" as const,
            receivedAtoms: "0",
          };
        if (
          row.depositType !== "CONFIDENTIAL_INTENTS" ||
          row.recipientType !== "DESTINATION_CHAIN" ||
          row.refundType !== "CONFIDENTIAL_INTENTS" ||
          row.originAsset !== monadUsdcAssetId ||
          row.destinationAsset !== q.destinationAsset ||
          !same(row.recipient, q.destinationRecipient) ||
          !same(row.refundTo, C) ||
          !nullable(row.depositMemo) ||
          !Array.isArray(row.quoteTransactions) ||
          row.quoteTransactions.length !== 1 ||
          decimal(row.amountInFormatted) !== BigInt(q.amountAtoms) ||
          date(row.createdAt) < q.quoteCreatedAtMs - 60000 ||
          date(row.createdAt) > this.now() + 5000
        )
          throw new Error("Changed payout history");
        const tx = object(row.quoteTransactions[0]);
        const actualIntent = intentHash(tx.txHash);
        if (
          !same(tx.sender, C) ||
          (entry.outcome?.intentHash &&
            entry.outcome.intentHash !== actualIntent)
        )
          throw new Error("Changed private transfer");
        const received = decimal(row.amountOutFormatted);
        if (received < BigInt(q.minimumDestinationAtoms))
          throw new Error("Delivered below minimum");
        if (entry.signedHash)
          entry.outcome = freeze({
            operationId: i.operationId,
            revision: i.revision,
            leg: i.leg,
            ...(q.distribution ? { distribution: q.distribution } : {}),
            quoteId: q.quoteId,
            status: "submitted" as const,
            intentHash: actualIntent,
            signedBodyHash: entry.signedHash!,
          });
        if (!i.destinationTransactionHash)
          return {
            ...base,
            status: "awaitingDestinationConfirmation" as const,
            receivedAtoms: "0",
            intentHash: actualIntent,
          };
        const { receipt, block } = await this.confirmDestination(
          q,
          i.destinationTransactionHash,
          received,
        );
        return {
          ...base,
          status: "delivered" as const,
          receivedAtoms: received.toString(),
          intentHash: actualIntent,
          destinationTransactionHash: receipt.transactionHash,
          referenceBlock: receipt.blockNumber.toString(),
          referenceHash: receipt.blockHash,
          authenticatedBodyHash: digest({
            historyRow: row,
            transactionHash: receipt.transactionHash,
            blockHash: receipt.blockHash,
          }),
        };
      } catch (error) {
        if (error instanceof NativeGatewayError || error instanceof CoordinationError) throw error;
        throw new NativeGatewayError(502, "EARN_PAYOUT_SETTLEMENT_UNAVAILABLE");
      }
    });
  }
}
