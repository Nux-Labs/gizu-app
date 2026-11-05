import type { OperationCoordinator } from "./operation-coordinator.ts";
import { boundUnsignedPayoutDeadline } from "./private-payout.ts";
import { base58 } from "@scure/base";
import {
  bytesToHex,
  verifyMessage,
  createPublicClient,
  http,
  parseEventLogs,
  erc20Abi,
} from "viem";
import type { Address, Hex } from "viem";
import { monadUsdcAssetId } from "../aurora/assets.ts";
import { auroraApi } from "../aurora/http.ts";
import {
  authenticateEarnRead,
  ConfidentialBalance,
} from "../aurora/confidential-balance.ts";
import type { ReadAuthentication } from "../aurora/confidential-balance.ts";
import { EarnRecoveryEnvelope } from "./recovery-envelope.ts";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address;
const obj = (v: any): any => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid cashout evidence");
  return v;
};
const same = (a: any, b: any) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const atoms = (v: any) => {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(v) ||
    BigInt(v) >= 1n << 256n
  )
    throw Error("Invalid amount");
  return BigInt(v);
};
function decimal(v: any) {
  if (typeof v !== "string" || v.length > 85 || !/^\d+(\.\d{1,6})?$/.test(v))
    throw Error("Invalid history amount");
  const [a, b = ""] = v.split(".");
  return BigInt(a!) * 1000000n + BigInt(b.padEnd(6, "0"));
}
export interface CashoutProviders {
  authenticate(auth: any): Promise<string>;
  balance(auth: any): Promise<any>;
  quote(request: any): Promise<any>;
  intent(source: string, deposit: string): Promise<any>;
  verify(intent: any): Promise<string>;
  history(auth: any, deposit: string): Promise<any[]>;
  reference(recipient: string): Promise<any>;
  confirm(quote: any, tx: string, amount: string): Promise<any>;
}
/** Encrypted per-child recovery transport with durable opaque receipt-event commitments. */
export class ConfidentialCashoutGateway {
  private envelope: EarnRecoveryEnvelope;
  private providers: CashoutProviders;
  private coordination: Pick<OperationCoordinator, "bind"> | undefined;
  constructor(
    config: {
      auroraApiKey?: string;
      recoveryKey?: string;
      coordination?: Pick<OperationCoordinator, "bind">;
    },
    providers?: CashoutProviders,
    private now = Date.now,
  ) {
    this.envelope = new EarnRecoveryEnvelope(config.recoveryKey);
    this.coordination = config.coordination;
    const api = (path: string, body?: unknown, token?: string) => {
      if (!config.auroraApiKey) throw Error("Cashout provider unavailable");
      return auroraApi(config.auroraApiKey, fetch, path, body, token);
    };
    const client = createPublicClient({
      transport: http("https://rpc.monad.xyz", {
        timeout: 12000,
        retryCount: 0,
      }),
    });
    this.providers = providers ?? {
      authenticate: (a) => authenticateEarnRead(a, this.now),
      balance: (a) => new ConfidentialBalance(config.auroraApiKey).read(a),
      quote: (r) => api("quote/{key}", r),
      intent: (signerId, depositAddress) =>
        api("generate-intent/{key}", {
          type: "swap_transfer",
          standard: "erc191",
          signerId,
          depositAddress,
        }).then((r) => {
          const i = obj(r.intent);
          i.payload = boundUnsignedPayoutDeadline(
            i.payload,
            this.now() + 60000,
            this.now(),
          );
          return i;
        }),
      verify: async (i) => {
        if (
          i.standard !== "erc191" ||
          typeof i.payload !== "string" ||
          i.payload.length > 8000 ||
          typeof i.signature !== "string" ||
          !i.signature.startsWith("secp256k1:")
        )
          throw Error("Invalid signed intent");
        const m = obj(JSON.parse(i.payload)),
          bytes = base58.decode(i.signature.slice(10));
        if (bytes.length !== 65 || bytes[64]! > 1)
          throw Error("Invalid signature");
        bytes[64]! += 27;
        if (
          !(await verifyMessage({
            address: m.signer_id,
            message: i.payload,
            signature: bytesToHex(bytes),
          }))
        )
          throw Error("Changed signer");
        return m.signer_id;
      },
      history: async (a, deposit) => {
        const session = await api("auth/authenticate/{key}", { signedData: a });
        if (
          typeof session.accessToken !== "string" ||
          session.accessToken.length > 8192
        )
          throw Error("Invalid session");
        const r = await api(
          "account/history/{key}?" +
            new URLSearchParams({
              depositAddress: deposit,
              status: "SUCCESS",
              depositType: "CONFIDENTIAL_INTENTS",
              recipientType: "DESTINATION_CHAIN",
              refundType: "CONFIDENTIAL_INTENTS",
              limit: "100",
            }),
          undefined,
          session.accessToken,
        );
        if (!Array.isArray(r.items) || r.items.length > 100)
          throw Error("Invalid history");
        return r.items;
      },
      reference: async (recipient) => {
        if ((await client.getChainId()) !== 143) throw Error("Wrong chain");
        const b = await client.getBlock({ blockTag: "finalized" });
        if (!b.hash) throw Error("Missing reference");
        return {
          referenceBlock: b.number.toString(),
          referenceHash: b.hash,
          initialDestinationAtoms: (
            await client.readContract({
              address: USDC,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [recipient as Address],
              blockNumber: b.number,
            })
          ).toString(),
        };
      },
      confirm: async (q, hash, received) => {
        if ((await client.getChainId()) !== 143)
          throw Error("Wrong destination chain");
        if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error("Invalid receipt");
        const r = await client.getTransactionReceipt({ hash: hash as Hex }),
          b = await client.getBlock({ blockNumber: r.blockNumber }),
          f = await client.getBlock({ blockTag: "finalized" });
        if (
          r.status !== "success" ||
          r.blockNumber <= BigInt(q.referenceBlock) ||
          r.blockHash !== b.hash ||
          f.number < r.blockNumber
        )
          throw Error("Unconfirmed receipt");
        const logs = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: r.logs,
          strict: true,
        }).filter(
          (l) =>
            same(l.address, USDC) && same(l.args.to, q.destinationRecipient),
        );
        if (logs.length !== 1 || logs[0]!.args.value !== atoms(received))
          throw Error("Changed receipt");
        if (
          (await client.getBlock({ blockNumber: r.blockNumber })).hash !==
          b.hash
        )
          throw Error("Reorg");
        return {
          transactionHash: hash,
          receivedAtoms: received,
          blockNumber: r.blockNumber.toString(),
          blockHash: b.hash,
          logIndex: logs[0]!.logIndex,
        };
      },
    };
  }
  async prepare(input: any): Promise<any> {
    if (!this.envelope.configured || !this.coordination)
      throw Error("Cashout durable coordination unavailable");
    if (
      !/^[-a-zA-Z0-9_]{1,128}$/.test(input.operationId) ||
      !/^0x[0-9a-f]{40}$/i.test(input.recipient) ||
      /^0x0{40}$/i.test(input.recipient)
    )
      throw Error("Invalid cashout request");
    const amount = atoms(input.amountAtoms);
    if (amount <= 0n) throw Error("Invalid amount");
    const C = await this.providers.authenticate(input.signedData),
      balance = obj(await this.providers.balance(input.signedData));
    if (
      !same(balance.confidentialAddress, C) ||
      balance.assetId !== monadUsdcAssetId ||
      balance.authenticated !== true ||
      balance.operationScoped !== false ||
      !Number.isSafeInteger(balance.timestampMs) ||
      this.now() - balance.timestampMs < -5000 ||
      this.now() - balance.timestampMs > 60000
    )
      throw Error("Changed balance");
    if (atoms(balance.available) < amount)
      throw Error("Insufficient authenticated private balance");
    const request = {
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "CONFIDENTIAL_INTENTS",
      recipientType: "DESTINATION_CHAIN",
      recipient: input.recipient,
      refundType: "CONFIDENTIAL_INTENTS",
      refundTo: C,
      originAsset: monadUsdcAssetId,
      destinationAsset: monadUsdcAssetId,
      amount: input.amountAtoms,
      slippageTolerance: 100,
      confidentiality: "advanced",
    };
    const response = obj(await this.providers.quote(request)),
      q = obj(response.quote),
      echo = obj(response.quoteRequest);
    for (const k of Object.keys(request))
      if (
        String(echo[k]).toLowerCase() !==
        String((request as any)[k]).toLowerCase()
      )
        throw Error("Changed quote");
    if (
      typeof response.signature !== "string" ||
      !response.signature ||
      q.amountIn !== input.amountAtoms ||
      atoms(q.minAmountOut) <= 0n ||
      atoms(q.minAmountOut) > amount ||
      atoms(q.amountOut) < atoms(q.minAmountOut) ||
      !Number.isFinite(Date.parse(q.deadline)) ||
      Date.parse(q.deadline) <= this.now()
    )
      throw Error("Changed quote");
    const intent = obj(await this.providers.intent(C, q.depositAddress));
    if (
      intent.standard !== "erc191" ||
      typeof intent.payload !== "string" ||
      intent.payload.length > 8000
    )
      throw Error("Invalid intent");
    const prepared = {
      operationId: input.operationId,
      confidentialAccount: C,
      destinationRecipient: input.recipient,
      destinationToken: USDC,
      destinationChainId: 143,
      assetId: monadUsdcAssetId,
      amountAtoms: input.amountAtoms,
      minimumDestinationAtoms: q.minAmountOut,
      depositId: q.depositAddress,
      quoteRequest: request,
      quoteResponse: response,
      intent,
      balance,
      observedAtMs: this.now(),
      expiresAtMs: Math.min(this.now() + 60000, Date.parse(q.deadline)),
      ...(await this.providers.reference(input.recipient)),
    };
    return {
      ...prepared,
      recoveryEnvelope: this.envelope.seal("confidential-cashout", prepared),
    };
  }
  async status(input: any): Promise<any> {
    const q = obj(
      this.envelope.open("confidential-cashout", input.recoveryEnvelope),
    );
    const C = await this.providers.authenticate(input.signedData);
    if (
      !same(C, q.confidentialAccount) ||
      input.submittedIntent?.payload !== q.intent.payload ||
      !same(await this.providers.verify(input.submittedIntent), C)
    )
      throw Error("Changed signed cashout");
    const history = await this.providers.history(input.signedData, q.depositId);
    const rows = history
      .map(obj)
      .filter((r) => r.depositAddress === q.depositId);
    if (rows.length > 1) throw Error("Changed duplicate history");
    const base = {
      operationId: q.operationId,
      confidentialAccount: C,
      destinationRecipient: q.destinationRecipient,
      amountAtoms: q.amountAtoms,
      minimumDestinationAtoms: q.minimumDestinationAtoms,
      authenticated: true,
      operationScoped: true,
      observedAtMs: this.now(),
    };
    if (!rows.length || rows[0].status !== "SUCCESS")
      return { ...base, status: "pending", receivedAtoms: "0" };
    const r = rows[0],
      transactions = r.quoteTransactions;
    if (
      r.depositType !== "CONFIDENTIAL_INTENTS" ||
      r.recipientType !== "DESTINATION_CHAIN" ||
      r.refundType !== "CONFIDENTIAL_INTENTS" ||
      r.originAsset !== q.assetId ||
      r.destinationAsset !== q.assetId ||
      !same(r.recipient, q.destinationRecipient) ||
      !same(r.refundTo, C) ||
      decimal(r.amountInFormatted) !== atoms(q.amountAtoms) ||
      !Number.isFinite(Date.parse(r.createdAt)) ||
      Date.parse(r.createdAt) < q.observedAtMs - 60000 ||
      Date.parse(r.createdAt) > this.now() + 5000 ||
      !Array.isArray(transactions) ||
      transactions.length !== 1 ||
      !same(transactions[0].sender, C) ||
      typeof transactions[0].txHash !== "string" ||
      (input.intentHash && input.intentHash !== transactions[0].txHash)
    )
      throw Error("Changed cashout history");
    const received = decimal(r.amountOutFormatted);
    if (received < atoms(q.minimumDestinationAtoms))
      throw Error("Changed cashout output");
    if (!input.destinationTransactionHash)
      return {
        ...base,
        status: "awaitingReceipt",
        receivedAtoms: received.toString(),
        intentHash: transactions[0].txHash,
      };
    const receipt = await this.providers.confirm(
      q,
      input.destinationTransactionHash,
      received.toString(),
    );
    if (
      !this.coordination ||
      !Number.isInteger(receipt.logIndex) ||
      receipt.logIndex < 0 ||
      !same(receipt.transactionHash, input.destinationTransactionHash)
    )
      throw Error("Invalid receipt event binding");
    // Only durable keyed commitments are retained; no raw addresses, payloads or catalogue.
    // Event commitments do not expire with a quote: signed children remain recoverable.
    await this.coordination.bind(
      "confidential-cashout-receipt",
      {
        chainId: 143,
        token: USDC,
        transactionHash: receipt.transactionHash.toLowerCase(),
        logIndex: receipt.logIndex,
      },
      {
        operationId: q.operationId,
        source: C,
        recipient: q.destinationRecipient,
        payload: q.intent.payload,
        intentHash: transactions[0].txHash,
      },
      253402300799000,
    );
    return {
      ...base,
      status: "paid",
      receivedAtoms: received.toString(),
      intentHash: transactions[0].txHash,
      receipt,
    };
  }
}
