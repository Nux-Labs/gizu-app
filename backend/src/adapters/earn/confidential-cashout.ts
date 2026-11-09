import {
  CoordinationError,
  type OperationCoordinator,
} from "./operation-coordinator.ts";
import {
  boundUnsignedPayoutDeadline,
  validatePrivatePayoutIntent,
} from "./private-payout.ts";
import {
  cashoutGroup,
  cashoutGroupId,
  type CashoutGroup,
} from "./cashout-group.ts";
import { base58 } from "@scure/base";
import {
  bytesToHex,
  getAddress,
  verifyMessage,
  createPublicClient,
  http,
  parseEventLogs,
  erc20Abi,
} from "viem";
import type { Address, Hex } from "viem";
import { monadUsdcAssetId, robinhoodUsdgAssetId } from "../aurora/assets.ts";
import { auroraApi } from "../aurora/http.ts";
import {
  authenticateEarnRead,
  ConfidentialBalance,
} from "../aurora/confidential-balance.ts";
import { ROBINHOOD_PROFILE } from "./robinhood-vault.ts";
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
/** Read-only provider work stays bounded even for the largest native matrix. */
async function cashoutReads<T, R>(
  values: T[],
  read: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        result[index] = await read(values[index]!, index);
      }
    }),
  );
  return result;
}
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
  routeStatus?(deposit: string): Promise<any>;
  confirmReceipt?(quote: any, tx: string): Promise<any>;
  confirmGroupReceipts?(quote: any, tx: string): Promise<any[]>;
  reference(recipient: string): Promise<any>;
  confirm(quote: any, tx: string, amount: string): Promise<any>;
}
interface ConfidentialPayoutConfiguration {
  auroraApiKey?: string;
  recoveryKey?: string;
  coordination?: Pick<OperationCoordinator, "bind">;
  robinhoodRpcUrl?: string;
}
interface PayoutDestination {
  purpose: "confidential-cashout" | "confidential-private-funding";
  chainId: 143 | 4663;
  token: Address;
  assetId: string;
  rpcUrl: string;
}
/** Fixed server-selected payout domains; callers cannot choose destination chains/assets. */
class ConfidentialPayoutGateway {
  private envelope: EarnRecoveryEnvelope;
  private providers: CashoutProviders;
  private coordination: Pick<OperationCoordinator, "bind"> | undefined;
  constructor(
    config: ConfidentialPayoutConfiguration,
    private destination: PayoutDestination,
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
      cacheTime: 0,
      transport: http(destination.rpcUrl, {
        timeout: 12000,
        retryCount: 0,
      }),
    });
    const confirmDestination = async (
      q: any,
      hash: string,
      received?: string,
      group = false,
    ) => {
      if ((await client.getChainId()) !== destination.chainId)
        throw Error("Wrong destination chain");
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error("Invalid receipt");
      const r = await client.getTransactionReceipt({ hash: hash as Hex }),
        b = await client.getBlock({ blockNumber: r.blockNumber }),
        f = await client.getBlock({ blockTag: "finalized" });
      if (
        r.status !== "success" ||
        !same(r.transactionHash, hash) ||
        (await client.getBlock({ blockNumber: BigInt(q.referenceBlock) }))
          .hash !== q.referenceHash ||
        r.blockNumber <= BigInt(q.referenceBlock) ||
        r.blockHash !== b.hash ||
        f.number === null ||
        f.number < r.blockNumber ||
        ((destination.purpose === "confidential-private-funding" ||
          received === undefined) &&
          (!Number.isSafeInteger(Number(b.timestamp) * 1000) ||
            Number(b.timestamp) * 1000 <
              (q.receiptObservedAtMs ?? q.observedAtMs) - 1000 ||
            Number(b.timestamp) * 1000 > this.now() + 5000))
      )
        throw Error("Unconfirmed receipt");
      const logs = parseEventLogs({
        abi: erc20Abi,
        eventName: "Transfer",
        logs: r.logs,
        strict: true,
      }).filter(
        (l) =>
          same(l.address, destination.token) &&
          same(l.args.to, q.destinationRecipient),
      );
      if (
        (!group && logs.length !== 1) ||
        (group &&
          (!logs.length ||
            logs.some((l) => l.removed === true || l.args.value <= 0n))) ||
        (received !== undefined && logs[0]!.args.value !== atoms(received)) ||
        (!group && logs[0]!.args.value < atoms(q.minimumDestinationAtoms)) ||
        logs[0]!.removed === true
      )
        throw Error("Changed receipt");
      if (
        (await client.getBlock({ blockNumber: r.blockNumber })).hash !== b.hash
      )
        throw Error("Reorg");
      if (group)
        return logs.map((l) => ({
          transactionHash: hash,
          receivedAtoms: l.args.value.toString(),
          blockNumber: r.blockNumber.toString(),
          blockHash: b.hash,
          logIndex: l.logIndex,
        }));
      return {
        transactionHash: hash,
        receivedAtoms: logs[0]!.args.value.toString(),
        blockNumber: r.blockNumber.toString(),
        blockHash: b.hash,
        logIndex: logs[0]!.logIndex,
      };
    };
    this.providers = providers ?? {
      authenticate: (a) => authenticateEarnRead(a, this.now),
      balance: (a) =>
        new ConfidentialBalance(config.auroraApiKey, fetch, this.now).read(a),
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
        if ((await client.getChainId()) !== destination.chainId)
          throw Error("Wrong chain");
        const b = await client.getBlock({ blockTag: "finalized" });
        if (!b.hash) throw Error("Missing reference");
        return {
          referenceBlock: b.number.toString(),
          referenceHash: b.hash,
          initialDestinationAtoms: (
            await client.readContract({
              address: destination.token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [recipient as Address],
              blockNumber: b.number,
            })
          ).toString(),
        };
      },
      confirm: (q, hash, received) => confirmDestination(q, hash, received),
      confirmReceipt: (q, hash) => confirmDestination(q, hash),
      confirmGroupReceipts: async (q, hash) =>
        confirmDestination(q, hash, undefined, true) as Promise<any[]>,
      routeStatus: (deposit) =>
        api(`status/{key}?depositAddress=${encodeURIComponent(deposit)}`),
    };
  }
  async prepare(
    input: any,
    receiptOnly = false,
    groupContext?: { group: CashoutGroup; anchor?: any },
  ): Promise<any> {
    if (receiptOnly && this.destination.purpose !== "confidential-cashout")
      throw Error("Unsupported receipt policy");
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
      destinationAsset: this.destination.assetId,
      amount: input.amountAtoms,
      slippageTolerance: 100,
      confidentiality: "advanced",
    };
    const response = obj(await this.providers.quote(request)),
      q = obj(response.quote),
      echo = obj(response.quoteRequest);
    for (const k of Object.keys(request))
      if (
        this.destination.purpose === "confidential-private-funding"
          ? ["recipient", "refundTo"].includes(k)
            ? !same(echo[k], (request as any)[k])
            : echo[k] !== (request as any)[k]
          : String(echo[k]).toLowerCase() !==
            String((request as any)[k]).toLowerCase()
      )
        throw Error("Changed quote");
    if (this.destination.purpose === "confidential-private-funding") {
      for (const row of [response, echo, q])
        if (
          (row.appFees != null &&
            (!Array.isArray(row.appFees) || row.appFees.length)) ||
          (row.feeBps != null && row.feeBps !== 0) ||
          (row.connectedWallets != null &&
            (!Array.isArray(row.connectedWallets) ||
              row.connectedWallets.length))
        )
          throw Error("Private funding additional fees or wallets");
      for (const row of [echo, q])
        for (const key of [
          "depositMemo",
          "chainDepositAddresses",
          "virtualChainRecipient",
          "virtualChainRefundRecipient",
          "customRecipientMsg",
        ])
          if (row[key] != null)
            throw Error("Private funding additional quote effects");
      if (
        typeof q.depositAddress !== "string" ||
        !/^[-a-zA-Z0-9_.:]{1,256}$/.test(q.depositAddress)
      )
        throw Error("Invalid private funding deposit");
    }
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
    let expiresAtMs = Math.min(this.now() + 60000, Date.parse(q.deadline));
    if (this.destination.purpose === "confidential-private-funding") {
      validatePrivatePayoutIntent(intent.payload, {
        signer: C,
        depositId: q.depositAddress,
        amountAtoms: input.amountAtoms,
      });
      intent.payload = boundUnsignedPayoutDeadline(
        intent.payload,
        Math.min(this.now() + 60000, Date.parse(q.deadline)),
        this.now(),
      );
      const { nonce, deadlineMs } = validatePrivatePayoutIntent(
        intent.payload,
        {
          signer: C,
          depositId: q.depositAddress,
          amountAtoms: input.amountAtoms,
        },
      );
      expiresAtMs = Math.min(expiresAtMs, deadlineMs);
      await this.coordination.bind(
        "payout-nonce",
        C.toLowerCase() + ":" + nonce,
        {
          key: this.destination.purpose + ":" + input.operationId,
          payload: intent.payload,
        },
        this.now() + 86400000,
      );
    }
    const prepared = {
      operationId: input.operationId,
      confidentialAccount: C,
      destinationRecipient: input.recipient,
      destinationToken: this.destination.token,
      destinationChainId: this.destination.chainId,
      assetId: monadUsdcAssetId,
      destinationAssetId: this.destination.assetId,
      ...(this.destination.purpose === "confidential-private-funding"
        ? { providerFeeBps: 0 }
        : {}),
      amountAtoms: input.amountAtoms,
      minimumDestinationAtoms: q.minAmountOut,
      depositId: q.depositAddress,
      quoteRequest: request,
      quoteResponse: response,
      intent,
      balance,
      observedAtMs: this.now(),
      expiresAtMs,
      ...(groupContext?.anchor
        ? {
            referenceBlock: groupContext.anchor.referenceBlock,
            referenceHash: groupContext.anchor.referenceHash,
            initialDestinationAtoms:
              groupContext.anchor.initialDestinationAtoms,
          }
        : await this.providers.reference(input.recipient)),
      ...(groupContext
        ? {
            cashoutGroup: groupContext.group,
            receiptObservedAtMs:
              groupContext.anchor?.receiptObservedAtMs ??
              groupContext.anchor?.observedAtMs ??
              this.now(),
          }
        : {}),
    };
    if (receiptOnly) {
      validatePrivatePayoutIntent(intent.payload, {
        signer: C,
        depositId: q.depositAddress,
        amountAtoms: input.amountAtoms,
      });
      if (groupContext)
        await this.bindGroupRecipient(
          groupContext.group,
          prepared,
          groupContext.anchor ? [groupContext.anchor] : [],
        );
      else await this.bindCashoutRecipient(prepared);
    }
    return {
      ...prepared,
      recoveryEnvelope: this.envelope.seal(this.destination.purpose, prepared),
    };
  }
  private groupMember(g: CashoutGroup, q: any, index: number) {
    const c = g.plan.children[index];
    if (
      !c ||
      q.operationId !== `${g.plan.proposal.operationId}_${index}` ||
      !same(
        q.confidentialAccount,
        g.plan.proposal.sources[c.source]!.address,
      ) ||
      !same(q.destinationRecipient, g.recipients[c.slot]) ||
      q.amountAtoms !== c.amountAtoms ||
      q.destinationChainId !== 143 ||
      !same(q.destinationToken, this.destination.token) ||
      q.assetId !== monadUsdcAssetId ||
      (q.destinationAssetId ?? q.assetId) !== monadUsdcAssetId ||
      q.quoteRequest?.destinationAsset !== monadUsdcAssetId ||
      (q.cashoutGroup &&
        cashoutGroupId(cashoutGroup(q.cashoutGroup)) !== cashoutGroupId(g))
    )
      throw Error("Changed saved group member");
    validatePrivatePayoutIntent(q.intent.payload, {
      signer: q.confidentialAccount,
      depositId: q.depositId,
      amountAtoms: c.amountAtoms,
    });
    return c;
  }
  private async tryCompatibleBind(
    scope: string,
    identity: unknown,
    binding: unknown,
    legacy: unknown[],
  ) {
    if (!this.coordination)
      throw Error("Cashout durable coordination unavailable");
    for (const candidate of [binding, ...legacy]) {
      try {
        await this.coordination.bind(
          scope,
          identity,
          candidate,
          253402300799000,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof CoordinationError) ||
          error.code !== "EARN_COORDINATION_CONFLICT"
        )
          throw error;
      }
    }
    throw new CoordinationError();
  }
  private async bindGroupRecipient(g: CashoutGroup, q: any, anchors: any[]) {
    if (!this.coordination || q.initialDestinationAtoms !== "0")
      throw Error("Fresh receiving wallet or sealed zero anchor required");
    const groupId = cashoutGroupId(g);
    await this.coordination.bind(
      "confidential-cashout-plan",
      g.plan.proposal.operationId,
      { groupId },
      253402300799000,
    );
    const identity = {
      chainId: 143,
      token: this.destination.token,
      recipient: q.destinationRecipient.toLowerCase(),
    };
    const binding = { verification: "destination-receipt-group-v1", groupId };
    // The secondary binding also prevents a legacy child from migrating into two plans.
    await this.coordination.bind(
      "confidential-cashout-recipient-group",
      identity,
      binding,
      253402300799000,
    );
    await this.tryCompatibleBind(
      "confidential-cashout-recipient",
      identity,
      binding,
      anchors
        .filter(
          (a) =>
            !a.cashoutGroup &&
            same(a.destinationRecipient, q.destinationRecipient),
        )
        .map((a) => ({
          operationId: a.operationId,
          source: a.confidentialAccount.toLowerCase(),
        })),
    );
  }
  async prepareGroup(input: any): Promise<any> {
    if (this.destination.purpose !== "confidential-cashout")
      throw Error("Unsupported receipt policy");
    const group = cashoutGroup(input.group),
      index = input.childIndex;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= group.plan.children.length
    )
      throw Error("Invalid group child");
    const child = group.plan.children[index]!;
    let anchor: any;
    if (input.anchor) {
      anchor = obj(this.envelope.open(this.destination.purpose, input.anchor));
      const oldIndex = group.plan.children.findIndex(
        (_, i) =>
          anchor.operationId === `${group.plan.proposal.operationId}_${i}`,
      );
      this.groupMember(group, anchor, oldIndex);
      if (
        !same(anchor.destinationRecipient, group.recipients[child.slot]) ||
        anchor.initialDestinationAtoms !== "0"
      )
        throw Error("Changed receiving anchor");
    }
    const source = await this.providers.authenticate(input.signedData);
    if (!same(source, group.plan.proposal.sources[child.source]!.address))
      throw Error("Changed group owner");
    return this.prepare(
      {
        operationId: `${group.plan.proposal.operationId}_${index}`,
        signedData: input.signedData,
        amountAtoms: child.amountAtoms,
        recipient: getAddress(group.recipients[child.slot]!),
      },
      true,
      { group, anchor },
    );
  }
  /** Public delivery belongs to the complete saved plan, never to a claimed private source transaction. */
  async groupStatus(input: any): Promise<any> {
    if (
      this.destination.purpose !== "confidential-cashout" ||
      !this.coordination ||
      !this.providers.routeStatus ||
      !this.providers.confirmGroupReceipts
    )
      throw Error("Group receipt policy unavailable");
    const group = cashoutGroup(input.group),
      p = group.plan.proposal,
      groupId = cashoutGroupId(group);
    if (
      !Array.isArray(input.owners) ||
      input.owners.length !== p.sources.length ||
      !Array.isArray(input.children) ||
      input.children.length !== group.plan.children.length ||
      !Array.isArray(input.destinationTransactionHashes) ||
      input.destinationTransactionHashes.length !== group.recipients.length
    )
      throw Error("Incomplete cashout group");
    for (const [i, auth] of input.owners.entries())
      if (!same(await this.providers.authenticate(auth), p.sources[i]!.address))
        throw Error("Changed group owner");
    const quotes: any[] = [];
    const nonces = new Set<string>();
    for (const [i, saved] of input.children.entries()) {
      if (saved === null) {
        quotes.push(null);
        continue;
      }
      const q = obj(
        this.envelope.open(this.destination.purpose, saved.recoveryEnvelope),
      );
      const c = this.groupMember(group, q, i);
      const { nonce } = validatePrivatePayoutIntent(q.intent.payload, {
        signer: q.confidentialAccount,
        depositId: q.depositId,
        amountAtoms: q.amountAtoms,
      });
      const nonceOwner = q.confidentialAccount.toLowerCase() + ":" + nonce;
      if (nonces.has(nonceOwner)) throw Error("Duplicate signed child nonce");
      nonces.add(nonceOwner);
      if (
        saved.submittedIntent?.payload !== q.intent.payload ||
        !same(
          await this.providers.verify(saved.submittedIntent),
          p.sources[c.source]!.address,
        )
      )
        throw Error("Changed signed group child");
      quotes.push(q);
    }
    for (const q of quotes.filter(Boolean))
      await this.bindGroupRecipient(group, q, quotes.filter(Boolean));
    // Once submitted, refreshed unsigned quotes can never replace any signed child on restore.
    if (quotes.every(Boolean))
      await this.coordination.bind(
        "confidential-cashout-group-signed",
        { groupId },
        quotes.map((q) => ({
          operationId: q.operationId,
          payload: q.intent.payload,
        })),
        253402300799000,
      );
    const base = {
      operationId: p.operationId,
      groupId,
      verification: "destination-receipt-group-v1",
      authenticated: true,
      operationScoped: true,
      observedAtMs: this.now(),
    };
    let pending = quotes.some((q) => !q);
    const routes: any[] = [];
    const routeEvidence = await cashoutReads(quotes, async (q) =>
      q ? obj(await this.providers.routeStatus!(q.depositId)) : null,
    );
    for (const [index, q] of quotes.entries()) {
      if (!q) continue;
      const route = routeEvidence[index]!;
      routes.push({ index, status: route.status });
      if (route.status !== "SUCCESS") {
        if (
          ![
            "KNOWN_DEPOSIT_TX",
            "PENDING_DEPOSIT",
            "INCOMPLETE_DEPOSIT",
            "PROCESSING",
          ].includes(route.status)
        )
          throw Error("Cashout route failed");
        pending = true;
      }
    }
    if (pending)
      return { ...base, observedAtMs: this.now(), status: "pending", routes };
    const slots: any[] = [],
      seen = new Set<string>();
    for (const [slot, recipient] of group.recipients.entries()) {
      const members = quotes.filter(
        (_, i) => group.plan.children[i]!.slot === slot,
      );
      const reference = [...members].sort((a, b) =>
        BigInt(a.referenceBlock) < BigInt(b.referenceBlock)
          ? -1
          : BigInt(a.referenceBlock) > BigInt(b.referenceBlock)
            ? 1
            : 0,
      )[0]!;
      const minimum = members.reduce(
        (n, q) => n + atoms(q.minimumDestinationAtoms),
        0n,
      );
      const hashes = input.destinationTransactionHashes[slot];
      if (
        !Array.isArray(hashes) ||
        hashes.length > 128 ||
        hashes.some(
          (h) => typeof h !== "string" || !/^0x[0-9a-f]{64}$/i.test(h),
        ) ||
        new Set(hashes.map((h) => h.toLowerCase())).size !== hashes.length
      )
        throw Error("Invalid group receipts");
      const receipts: any[] = [];
      const confirmations = await cashoutReads(hashes, (hash) =>
        this.providers.confirmGroupReceipts!(reference, hash),
      );
      for (const [hashIndex, hash] of hashes.entries()) {
        const events = confirmations[hashIndex];
        if (!Array.isArray(events) || !events.length || events.length > 4096)
          throw Error("Invalid group receipt events");
        for (const receipt of events) {
          if (
            !Number.isSafeInteger(receipt.logIndex) ||
            receipt.logIndex < 0 ||
            !same(receipt.transactionHash, hash) ||
            atoms(receipt.receivedAtoms) <= 0n ||
            !/^(0|[1-9][0-9]*)$/.test(receipt.blockNumber) ||
            !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)
          )
            throw Error("Invalid delivery receipt");
          const identity = `${hash.toLowerCase()}:${receipt.logIndex}`;
          if (seen.has(identity)) throw Error("Duplicate group receipt event");
          seen.add(identity);
          receipts.push({ ...receipt, transactionHash: hash.toLowerCase() });
        }
      }
      receipts.sort((a, b) =>
        BigInt(a.blockNumber) < BigInt(b.blockNumber)
          ? -1
          : BigInt(a.blockNumber) > BigInt(b.blockNumber)
            ? 1
            : a.transactionHash.localeCompare(b.transactionHash) ||
              a.logIndex - b.logIndex,
      );
      const received = receipts.reduce(
        (n, r) => n + atoms(r.receivedAtoms),
        0n,
      );
      slots.push({
        slot,
        destinationRecipient: recipient,
        minimumDestinationAtoms: minimum.toString(),
        receivedAtoms: received.toString(),
        receipts,
      });
    }
    if (
      slots.some(
        (s) => atoms(s.receivedAtoms) < atoms(s.minimumDestinationAtoms),
      )
    )
      return {
        ...base,
        observedAtMs: this.now(),
        status: "awaitingReceipt",
        routes,
      };
    for (const s of slots)
      for (const receipt of s.receipts) {
        const identity = {
          chainId: 143,
          token: this.destination.token,
          transactionHash: receipt.transactionHash,
          logIndex: receipt.logIndex,
        };
        const binding = {
          verification: "destination-receipt-group-v1",
          groupId,
        };
        const legacy = quotes.flatMap((q, i) => {
          if (q.cashoutGroup || group.plan.children[i]!.slot !== s.slot)
            return [];
          const owner = {
            operationId: q.operationId,
            source: q.confidentialAccount,
            recipient: q.destinationRecipient,
            payload: q.intent.payload,
          };
          const hash = input.children[i].intentHash;
          return [
            { verification: "destination-receipt-v1", ...owner },
            ...(typeof hash === "string" && hash.length > 0
              ? [{ ...owner, intentHash: hash }]
              : []),
          ];
        });
        await this.coordination.bind(
          "confidential-cashout-receipt-group",
          identity,
          binding,
          253402300799000,
        );
        await this.tryCompatibleBind(
          "confidential-cashout-receipt",
          identity,
          binding,
          legacy,
        );
      }
    return { ...base, observedAtMs: this.now(), status: "paid", slots, routes };
  }
  private async bindCashoutRecipient(q: any) {
    if (!this.coordination || q.initialDestinationAtoms !== "0")
      throw Error("Fresh receiving wallet required");
    await this.coordination.bind(
      "confidential-cashout-recipient",
      {
        chainId: this.destination.chainId,
        token: this.destination.token,
        recipient: q.destinationRecipient.toLowerCase(),
      },
      {
        operationId: q.operationId,
        source: q.confidentialAccount.toLowerCase(),
      },
      253402300799000,
    );
  }
  /** Separate public-delivery evidence; never attests an exact private-ledger transaction. */
  private async receiptStatus(input: any, q: any, C: string) {
    if (
      this.destination.purpose !== "confidential-cashout" ||
      !this.providers.routeStatus ||
      !this.providers.confirmReceipt
    )
      throw Error("Receipt policy unavailable");
    validatePrivatePayoutIntent(q.intent.payload, {
      signer: C,
      depositId: q.depositId,
      amountAtoms: q.amountAtoms,
    });
    await this.bindCashoutRecipient(q);
    const route = obj(await this.providers.routeStatus(q.depositId));
    const base = {
      operationId: q.operationId,
      confidentialAccount: C,
      destinationRecipient: q.destinationRecipient,
      destinationChainId: this.destination.chainId,
      destinationToken: this.destination.token,
      assetId: monadUsdcAssetId,
      destinationAssetId: this.destination.assetId,
      amountAtoms: q.amountAtoms,
      minimumDestinationAtoms: q.minimumDestinationAtoms,
      authenticated: true,
      operationScoped: true,
      observedAtMs: this.now(),
      verification: "destination-receipt-v1",
    };
    if (route.status !== "SUCCESS") {
      if (
        ![
          "KNOWN_DEPOSIT_TX",
          "PENDING_DEPOSIT",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
        ].includes(route.status)
      )
        throw Error("Cashout route failed");
      return { ...base, status: "pending", receivedAtoms: "0" };
    }
    if (!input.destinationTransactionHash)
      return { ...base, status: "awaitingReceipt", receivedAtoms: "0" };
    const receipt = obj(
      await this.providers.confirmReceipt(q, input.destinationTransactionHash),
    );
    if (
      !Number.isSafeInteger(receipt.logIndex) ||
      receipt.logIndex < 0 ||
      !same(receipt.transactionHash, input.destinationTransactionHash) ||
      atoms(receipt.receivedAtoms) < atoms(q.minimumDestinationAtoms)
    )
      throw Error("Invalid delivery receipt");
    const identity = {
      chainId: this.destination.chainId,
      token: this.destination.token,
      transactionHash: receipt.transactionHash.toLowerCase(),
      logIndex: receipt.logIndex,
    };
    const owner = {
      operationId: q.operationId,
      source: C,
      recipient: q.destinationRecipient,
      payload: q.intent.payload,
    };
    const bindReceipt = (binding: unknown) =>
      this.coordination!.bind(
        "confidential-cashout-receipt",
        identity,
        binding,
        253402300799000,
      );
    // New ownership is independent of provider-hash availability, so an earlier
    // hashless backup can replay after a response was lost. Only keyed commitments persist.
    try {
      await bindReceipt({ verification: "destination-receipt-v1", ...owner });
    } catch (error) {
      if (
        !(error instanceof CoordinationError) ||
        error.code !== "EARN_COORDINATION_CONFLICT" ||
        typeof input.intentHash !== "string" ||
        input.intentHash.length === 0
      )
        throw error;
      // Recover only the exact legacy owner, without replacing its permanent claim.
      // Unknown legacy hashes and legacy rollback of new claims fail closed.
      await bindReceipt({ ...owner, intentHash: input.intentHash });
    }
    return {
      ...base,
      status: "paid",
      receivedAtoms: receipt.receivedAtoms,
      receipt,
    };
  }
  async status(input: any, receiptOnly = false): Promise<any> {
    const q = obj(
      this.envelope.open(this.destination.purpose, input.recoveryEnvelope),
    );
    if (
      q.destinationChainId !== this.destination.chainId ||
      !same(q.destinationToken, this.destination.token) ||
      q.assetId !== monadUsdcAssetId ||
      (q.destinationAssetId ?? q.assetId) !== this.destination.assetId ||
      q.quoteRequest?.destinationAsset !== this.destination.assetId
    )
      throw Error("Changed payout destination");
    if (this.destination.purpose === "confidential-private-funding")
      validatePrivatePayoutIntent(q.intent.payload, {
        signer: q.confidentialAccount,
        depositId: q.depositId,
        amountAtoms: q.amountAtoms,
      });
    const C = await this.providers.authenticate(input.signedData);
    if (
      !same(C, q.confidentialAccount) ||
      input.submittedIntent?.payload !== q.intent.payload ||
      !same(await this.providers.verify(input.submittedIntent), C)
    )
      throw Error("Changed signed cashout");
    if (receiptOnly) return this.receiptStatus(input, q, C);
    const history = await this.providers.history(input.signedData, q.depositId);
    const rows = history
      .map(obj)
      .filter((r) => r.depositAddress === q.depositId);
    if (rows.length > 1) throw Error("Changed duplicate history");
    const base = {
      operationId: q.operationId,
      confidentialAccount: C,
      destinationRecipient: q.destinationRecipient,
      destinationChainId: this.destination.chainId,
      destinationToken: this.destination.token,
      assetId: monadUsdcAssetId,
      destinationAssetId: this.destination.assetId,
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
      r.destinationAsset !== (q.destinationAssetId ?? q.assetId) ||
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
        chainId: this.destination.chainId,
        token: this.destination.token,
        transactionHash: receipt.transactionHash.toLowerCase(),
        logIndex: receipt.logIndex,
      },
      {
        ...(this.destination.purpose === "confidential-private-funding"
          ? { purpose: this.destination.purpose }
          : {}),
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

/** Cashout always pays public Monad USDC; request data cannot select another route. */
export class ConfidentialCashoutGateway extends ConfidentialPayoutGateway {
  constructor(
    config: ConfidentialPayoutConfiguration,
    providers?: CashoutProviders,
    now = Date.now,
  ) {
    super(
      config,
      {
        purpose: "confidential-cashout",
        chainId: 143,
        token: USDC,
        assetId: monadUsdcAssetId,
        rpcUrl: "https://rpc.monad.xyz",
      },
      providers,
      now,
    );
  }
}
/** Private Earn funding pays the exact native-selected investment recipient in Robinhood USDG. */
export class ConfidentialPrivateFundingGateway extends ConfidentialPayoutGateway {
  constructor(
    config: ConfidentialPayoutConfiguration,
    providers?: CashoutProviders,
    now = Date.now,
  ) {
    super(
      config,
      {
        purpose: "confidential-private-funding",
        chainId: 4663,
        token: ROBINHOOD_PROFILE.token,
        assetId: robinhoodUsdgAssetId,
        rpcUrl:
          config.robinhoodRpcUrl ?? "https://rpc.mainnet.chain.robinhood.com",
      },
      providers,
      now,
    );
  }
}
