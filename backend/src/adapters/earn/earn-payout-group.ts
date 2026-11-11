import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticateEarnRead } from "../aurora/confidential-balance.ts";
import { distributionSchema } from "./distribution.ts";
import { ROBINHOOD_PROFILE } from "./robinhood-vault.ts";
import { type OperationCoordinator } from "./operation-coordinator.ts";
import { NativeGatewayError } from "./native-gateway.ts";
import type { PrivatePayoutGateway } from "./private-payout.ts";
import type { ConfidentialPrivateFundingGateway } from "./confidential-cashout.ts";
const id = z.string().regex(/^[-a-zA-Z0-9_]{1,128}$/);
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .refine((v) => !/^0x0{40}$/i.test(v));
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const signed = z
  .object({
    standard: z.literal("erc191"),
    payload: z.string().min(1).max(8000),
    signature: z.string().min(1).max(256),
  })
  .strict();
const groupSchema = z
  .object({
    version: z.literal(1),
    journeyId: id,
    cycleIndex: z.number().int().min(0).max(715827881),
    distribution: distributionSchema,
    recipients: z.array(address).min(1).max(5),
    members: z
      .array(
        z
          .object({
            operationId: id,
            leg: z.string().regex(/^invest:[0-4]$/),
            kind: z.enum(["private", "funded"]),
            recipient: address,
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
const requestSchema = z
  .object({
    group: groupSchema,
    children: z
      .array(
        z
          .object({
            recoveryEnvelope: z.string().min(1).max(180000),
            submittedIntent: signed,
            revision: z.number().int().positive().max(2147483647),
            intentHash: z.string().min(1).max(256).optional(),
          })
          .strict()
          .nullable(),
      )
      .min(1)
      .max(256),
    owners: z.array(signed).min(1).max(128),
    destinationTransactionHashes: z.array(z.array(hash).max(128)).min(1).max(5),
  })
  .strict();
type Group = z.output<typeof groupSchema>;
type Receipt = {
  transactionHash: string;
  logIndex: number;
  receivedAtoms: string;
  blockNumber: string;
  blockHash: string;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const lower = (s: string) => s.toLowerCase();
const amount = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(v) ||
    BigInt(v) >= 1n << 256n
  )
    throw Error("Invalid group amount");
  return BigInt(v);
};
/** Same recursively sorted JSON as native depositCanonical; array order is authoritative. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const earnPayoutGroupId = (group: Group) =>
  "0x" +
  createHash("sha256")
    .update(JSON.stringify(canonical(group)))
    .digest("hex");
const permanent = 253402300799000;
async function reads<T, R>(
  values: T[],
  work: (value: T, index: number) => Promise<R>,
) {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await work(values[index]!, index);
      }
    }),
  );
  return output;
}
export interface EarnPayoutGroupConfiguration {
  coordination: Pick<OperationCoordinator, "bindMany">;
  privateGateway: ConfidentialPrivateFundingGateway;
  fundedGateway: PrivatePayoutGateway;
  now?: () => number;
  confirmReceipts?: (
    quote: any,
    hash: string,
    references: any[],
  ) => Promise<Receipt[]>;
}
/** Authenticated read-only delivery proof. Its authority is existing sealed/signed children. */
export class EarnPayoutGroupGateway {
  private now: () => number;
  constructor(private config: EarnPayoutGroupConfiguration) {
    this.now = config.now ?? Date.now;
  }
  async status(value: unknown) {
    let input: z.output<typeof requestSchema>;
    try {
      input = requestSchema.parse(value);
    } catch {
      throw new NativeGatewayError(400, "INVALID_EARN_PAYOUT_GROUP");
    }
    const { group, children } = input,
      slotsCount = group.recipients.length;
    if (
      group.distribution.weightsBps.length !== slotsCount ||
      input.destinationTransactionHashes.length !== slotsCount ||
      children.length !== group.members.length ||
      new Set(group.recipients.map(lower)).size !== slotsCount ||
      group.members.length % slotsCount !== 0
    )
      throw Error("Incomplete Earn payout group");
    const sourceIds = new Set<string>();
    // A source contributes every slot, in native review order. No caller can omit a sibling.
    for (let index = 0; index < group.members.length; index += slotsCount) {
      const first = group.members[index]!;
      if (sourceIds.has(first.operationId))
        throw Error("Duplicate group source");
      sourceIds.add(first.operationId);
      for (let slot = 0; slot < slotsCount; slot++) {
        const member = group.members[index + slot]!;
        if (
          member.operationId !== first.operationId ||
          member.kind !== first.kind ||
          member.leg !== `invest:${slot}` ||
          !same(member.recipient, group.recipients[slot]!)
        )
          throw Error("Changed group matrix");
      }
    }
    for (const hashes of input.destinationTransactionHashes)
      if (new Set(hashes.map(lower)).size !== hashes.length)
        throw Error("Duplicate receipt hash");
    const owners = new Set(
      await reads(input.owners, async (owner) =>
        lower(await authenticateEarnRead(owner, this.now)),
      ),
    );
    const quotes: any[] = [],
      nonces = new Set<string>(),
      deposits = new Set<string>();
    let priorFundedIndex = -1;
    for (const [index, saved] of children.entries()) {
      if (saved === null) {
        quotes.push(null);
        continue;
      }
      const member = group.members[index]!;
      const q =
        member.kind === "private"
          ? await this.config.privateGateway.restoreEarnGroupMember(
              member,
              saved,
            )
          : await this.config.fundedGateway.restoreEarnGroupMember(
              member,
              saved,
              group.distribution,
              group.cycleIndex,
            );
      if (
        !owners.has(lower(q.confidentialAccount)) ||
        amount(q.minimumDestinationAtoms) <= 0n ||
        !/^0x[0-9a-f]{64}$/i.test(q.referenceHash) ||
        !/^(0|[1-9][0-9]*)$/.test(q.referenceBlock) ||
        !Number.isSafeInteger(q.quoteCreatedAtMs)
      )
        throw Error("Changed group evidence");
      const nonce = `${lower(q.confidentialAccount)}:${q.nonce}`,
        deposit = q.depositId;
      if (nonces.has(nonce) || deposits.has(deposit))
        throw Error("Duplicate signed group child");
      nonces.add(nonce);
      deposits.add(deposit);
      if (
        index % slotsCount !== 0 &&
        quotes[index - 1] &&
        !same(q.confidentialAccount, quotes[index - 1].confidentialAccount)
      )
        throw Error("Changed source signer");
      if (member.kind === "funded" && index % slotsCount === 0) {
        if (q.sourceAccountIndex <= priorFundedIndex)
          throw Error("Changed source order");
        priorFundedIndex = q.sourceAccountIndex;
      }
      quotes.push(q);
    }
    const groupId = earnPayoutGroupId(group),
      base = {
        groupId,
        verification: "signed-route-receipt-group-v1",
        authenticated: true,
        operationScoped: true,
      };
    const routeEvidence = await reads(quotes, (q, index) =>
      q
        ? (group.members[index]!.kind === "private"
            ? this.config.privateGateway
            : this.config.fundedGateway
          ).earnGroupRouteStatus(q.depositId)
        : Promise.resolve(null),
    );
    const routes: Array<{ index: number; status: string }> = [];
    let pending = quotes.some((q) => !q);
    for (const [index, route] of routeEvidence.entries()) {
      if (!route) continue;
      if (
        typeof route.status !== "string" ||
        ![
          "SUCCESS",
          "KNOWN_DEPOSIT_TX",
          "PENDING_DEPOSIT",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
        ].includes(route.status)
      )
        throw Error("Earn payout route failed");
      routes.push({ index, status: route.status });
      if (route.status !== "SUCCESS") pending = true;
    }
    // Partial unsigned groups carry no authority to reserve recipients or immutable membership.
    if (pending)
      return { ...base, observedAtMs: this.now(), status: "pending", routes };
    const slots: Array<{
        slot: number;
        destinationRecipient: string;
        minimumDestinationAtoms: string;
        receivedAtoms: string;
        receipts: Receipt[];
      }> = [],
      seen = new Set<string>();
    let count = 0;
    const verifyReceipt =
      !this.config.confirmReceipts &&
      input.destinationTransactionHashes.some((hashes) => hashes.length)
        ? await this.config.fundedGateway.createEarnGroupReceiptVerifier(quotes)
        : null;
    for (const [slot, recipient] of group.recipients.entries()) {
      const members = quotes.filter((_, index) => index % slotsCount === slot);
      const reference = [...members].sort((a, b) =>
        BigInt(a.referenceBlock) < BigInt(b.referenceBlock)
          ? -1
          : BigInt(a.referenceBlock) > BigInt(b.referenceBlock)
            ? 1
            : a.quoteCreatedAtMs - b.quoteCreatedAtMs,
      )[0]!;
      const aggregate = {
        ...reference,
        quoteCreatedAtMs: Math.min(...members.map((q) => q.quoteCreatedAtMs)),
        destinationRecipient: recipient,
      };
      const minimum = members.reduce(
        (n, q) => n + amount(q.minimumDestinationAtoms),
        0n,
      );
      if (minimum >= 1n << 256n) throw Error("Group amount overflow");
      const confirmations = await reads(
        input.destinationTransactionHashes[slot]!,
        (hash) =>
          this.config.confirmReceipts
            ? this.config.confirmReceipts(aggregate, hash, members)
            : verifyReceipt!(aggregate, hash),
      );
      const receipts: Receipt[] = [];
      for (const [hashIndex, events] of confirmations.entries()) {
        const hash = input.destinationTransactionHashes[slot]![hashIndex]!;
        if (!Array.isArray(events) || !events.length)
          throw Error("Missing group transfer events");
        for (const receipt of events) {
          if (
            ++count > 640 ||
            !Number.isSafeInteger(receipt.logIndex) ||
            receipt.logIndex < 0 ||
            !same(receipt.transactionHash, hash) ||
            amount(receipt.receivedAtoms) <= 0n ||
            !/^(0|[1-9][0-9]*)$/.test(receipt.blockNumber) ||
            !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)
          )
            throw Error("Invalid group receipt");
          const identity = `${lower(hash)}:${receipt.logIndex}`;
          if (seen.has(identity)) throw Error("Duplicate group receipt event");
          seen.add(identity);
          receipts.push({
            transactionHash: lower(hash),
            logIndex: receipt.logIndex,
            receivedAtoms: receipt.receivedAtoms,
            blockNumber: receipt.blockNumber,
            blockHash: lower(receipt.blockHash),
          });
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
        (n, r) => n + amount(r.receivedAtoms),
        0n,
      );
      if (received >= 1n << 256n) throw Error("Group amount overflow");
      slots.push({
        slot,
        destinationRecipient: recipient,
        minimumDestinationAtoms: minimum.toString(),
        receivedAtoms: received.toString(),
        receipts,
      });
    }
    // A canonical receipt on a new fork cannot reuse an anchor observed on the
    // old fork. Bracket the whole batch before committing any proof or claim.
    await verifyReceipt?.recheckReferences();
    if (
      slots.some(
        (s) => amount(s.receivedAtoms) < amount(s.minimumDestinationAtoms),
      )
    )
      return {
        ...base,
        observedAtMs: this.now(),
        status: "awaitingReceipt",
        routes,
      };
    const claims: Array<{
      scope: string;
      identity: unknown;
      binding: unknown;
      compatible?: unknown[];
    }> = [];
    const bind = (
      scope: string,
      identity: unknown,
      binding: unknown,
      compatible?: unknown[],
    ) => {
      claims.push({
        scope,
        identity,
        binding,
        ...(compatible ? { compatible } : {}),
      });
    };
    {
      bind(
        "earn-payout-group-signed",
        { groupId },
        quotes.map((q, index) => ({
          member: group.members[index],
          revision: children[index]!.revision,
          payload: q.intent.payload,
        })),
      );
      for (const [index, q] of quotes.entries()) {
        const binding = { groupId };
        bind(
          "earn-payout-group-child",
          {
            operationId: group.members[index]!.operationId,
            leg: group.members[index]!.leg,
            source: lower(q.confidentialAccount),
          },
          binding,
        );
        bind("earn-payout-group-deposit", { depositId: q.depositId }, binding);
        bind(
          "earn-payout-group-nonce",
          { source: lower(q.confidentialAccount), nonce: q.nonce },
          binding,
        );
      }
    }
    for (const slot of slots)
      for (const receipt of slot.receipts) {
        const identity = {
          chainId: 4663,
          token: ROBINHOOD_PROFILE.token,
          transactionHash: receipt.transactionHash,
          logIndex: receipt.logIndex,
        };
        const binding = { verification: base.verification, groupId };
        const legacy = quotes.flatMap((q, index) => {
          if (
            index % slotsCount !== slot.slot ||
            group.members[index]!.kind !== "private"
          )
            return [];
          const owner = {
            purpose: "confidential-private-funding",
            operationId: q.operationId,
            source: q.confidentialAccount,
            recipient: q.destinationRecipient,
            payload: q.intent.payload,
          };
          return [
            { verification: "signed-route-receipt-v1", ...owner },
            ...(children[index]!.intentHash
              ? [{ ...owner, intentHash: children[index]!.intentHash }]
              : []),
          ];
        });
        bind("confidential-cashout-receipt-group", identity, binding);
        bind("confidential-cashout-receipt", identity, binding, legacy);
      }
    // Commit only a digest of the normalized accepted set. Lost responses can replay exactly;
    // later gifts and reorg mutations can never change completed delivery.
    bind("earn-payout-group-proof", { groupId }, slots);
    await this.config.coordination.bindMany(claims, permanent);
    return { ...base, observedAtMs: this.now(), status: "paid", routes, slots };
  }
}
