import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, keccak256, toHex } from "viem";
import { base58 } from "@scure/base";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import { OperationCoordinator } from "../../../src/adapters/earn/operation-coordinator.ts";
import { ConfidentialPrivateFundingGateway } from "../../../src/adapters/earn/confidential-cashout.ts";
import { PrivatePayoutGateway } from "../../../src/adapters/earn/private-payout.ts";
import {
  monadUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
import { ROBINHOOD_PROFILE } from "../../../src/adapters/earn/robinhood-vault.ts";
const module =
  (await import("../../../src/adapters/earn/earn-payout-group.ts").catch(
    () => ({}),
  )) as any;
const at = Date.parse("2026-11-11T12:00:00Z"),
  key = "ab".repeat(32);
const account = privateKeyToAccount(
  ("0x" + "00".repeat(31) + "01") as `0x${string}`,
);
const C = account.address.toLowerCase(),
  R = "0x" + "22".repeat(20),
  H = "0x" + "33".repeat(32),
  B = "0x" + "44".repeat(32);
async function signed(payload: string) {
  const bytes = hexToBytes(await account.signMessage({ message: payload }));
  bytes[64]! -= 27;
  return {
    standard: "erc191",
    payload,
    signature: "secp256k1:" + base58.encode(bytes),
  };
}
async function fixture(kinds = ["private", "funded"]) {
  let clock = at;
  const commits = new Map<string, string>();
  const coordination = new OperationCoordinator(
    {
      bind: async (id, value) => {
        if (commits.has(id) && commits.get(id) !== value) return false;
        commits.set(id, value);
        return true;
      },
      bindMany: async (bindings) => {
        if (
          bindings.some(
            (row) =>
              commits.has(row.opaqueKey) &&
              !row.commitments.includes(commits.get(row.opaqueKey)!),
          )
        )
          return false;
        for (const row of bindings)
          if (!commits.has(row.opaqueKey))
            commits.set(row.opaqueKey, row.commitments[0]!);
        return true;
      },
    },
    "cd".repeat(32),
  );
  const envelope = new EarnRecoveryEnvelope(key),
    quotes: any[] = [];
  const distribution = { version: 1, weightsBps: [10000] };
  const group = {
    version: 1,
    journeyId: "journey_1",
    cycleIndex: 0,
    distribution,
    recipients: [R],
    members: kinds.map((kind, i) => ({
      operationId: "source_" + i,
      leg: "invest:0",
      kind,
      recipient: R,
    })),
  };
  const children: any[] = [];
  for (const [i, kind] of kinds.entries()) {
    const operationId = "source_" + i,
      depositId = "payout-" + i + ".near";
    const payload = JSON.stringify({
      signer_id: C,
      verifying_contract: "intents.far",
      nonce: Buffer.alloc(32, i + 1).toString("base64"),
      deadline: new Date(at + 60000).toISOString(),
      intents: [
        {
          intent: "transfer",
          receiver_id: depositId,
          tokens: {
            ["imt:" + "55".repeat(32) + ":" + monadUsdcAssetId]: "1000000",
          },
        },
      ],
    });
    const quote = {
      operationId: kind === "private" ? operationId + "_0" : operationId,
      revision: 1,
      leg: "invest:0",
      distribution,
      confidentialAccount: C,
      amountAtoms: "1000000",
      depositId,
      destinationRecipient: R,
      destinationToken: ROBINHOOD_PROFILE.token,
      destinationChainId: 4663,
      referenceBlock: "100",
      referenceHash: B,
      quoteCreatedAtMs: at,
      observedAtMs: at,
      minimumDestinationAtoms: "980000",
      intent: { standard: "erc191", payload },
      assetId: monadUsdcAssetId,
      destinationAssetId: robinhoodUsdgAssetId,
      quoteRequest: { destinationAsset: robinhoodUsdgAssetId },
      quoteId: "0x" + "66".repeat(32),
      payloadHash: keccak256(toHex(payload)),
      deadlineMs: at + 60000,
      profileChainId: 4663,
    };
    quotes.push(quote);
    const source = {
      operationId,
      revision: 1,
      quoteId: "0x" + "77".repeat(32),
      depositAddress: "0x" + "88".repeat(20),
      sourceOwner: R,
      confidentialAccount: C,
      originAsset: monadUsdcAssetId,
      amountAtoms: "1000000",
      minimumCreditAtoms: "1000000",
      transactionHash: "0x" + (i + 1).toString().repeat(64),
    };
    const request = {
      operationId,
      revision: 1,
      leg: "invest:0",
      distribution,
      profileChainId: 4663,
      recipient: R,
      sourceAccountIndex: i,
      cycleIndex: 0,
      splitOffsetAtoms: "0",
      source,
    };
    const sealed =
      kind === "private"
        ? envelope.seal("confidential-private-funding", quote)
        : envelope.seal("private-payout", {
            version: 1,
            request,
            prepared: {
              quote,
              intent: quote.intent,
              sourceCredit: {
                operationId,
                revision: 1,
                sourceTransactionHash: source.transactionHash,
                sourceQuoteId: source.quoteId,
                sourceOwner: R,
                creditedAtoms: "1000000",
              },
            },
          });
    children.push({
      recoveryEnvelope: sealed,
      submittedIntent: await signed(payload),
      revision: 1,
    });
  }
  const owners = [
    await signed(
      JSON.stringify({
        deadline: new Date(at + 300000).toISOString(),
        intents: [],
        nonce: (() => {
          const n = Buffer.alloc(32);
          Buffer.from("5628f6c600", "hex").copy(n);
          n.writeBigUInt64LE(BigInt(at + 300000) * 1000000n, 9);
          n.writeBigUInt64LE(BigInt(at) * 1000000n, 17);
          return n.toString("base64");
        })(),
        signer_id: C,
        verifying_contract: "intents.near",
      }),
    ),
  ];
  let route = "SUCCESS";
  const providers: any = {
    authenticate: async () => C,
    verify: async (s: any) => {
      const original = children.find(
        (c) => c.submittedIntent.payload === s.payload,
      );
      if (!original || original.submittedIntent.signature !== s.signature)
        throw Error("Changed signature");
      return C;
    },
    history: async () => {
      throw Error("History forbidden");
    },
    routeStatus: async () => ({ status: route }),
  };
  const events = [0, 1].map((logIndex) => ({
    transactionHash: H,
    logIndex,
    receivedAtoms: "990000",
    blockNumber: "101",
    blockHash: B,
  }));
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).includes("/status/"))
      throw Error("History/provider mutation forbidden");
    return new Response(JSON.stringify({ status: route }));
  };
  const privateGateway = new ConfidentialPrivateFundingGateway(
    { coordination, recoveryKey: key },
    providers,
    () => at,
  );
  const funded = new PrivatePayoutGateway(
    { recoveryKey: key, coordination, auroraApiKey: "test" },
    { now: () => at, fetcher },
  );
  const create = () => {
    assert.equal(
      typeof module.EarnPayoutGroupGateway,
      "function",
      "Earn grouped verifier must exist",
    );
    return new module.EarnPayoutGroupGateway({
      coordination,
      privateGateway,
      fundedGateway: funded,
      now: () => clock,
      confirmReceipts: async () => events,
    });
  };
  const input = {
    group,
    children,
    owners,
    destinationTransactionHashes: [[H]],
  };
  return {
    create,
    input,
    events,
    quotes,
    envelope,
    coordination,
    privateGateway,
    funded,
    commits,
    advance: (ms: number) => {
      clock += ms;
    },
    setRoute: (s: string) => {
      route = s;
    },
  };
}
test("mixed saved seals prove recipient totals with batched transfers and survive restart without history", async () => {
  const f = await fixture();
  const result = await f.create().status(f.input);
  assert.equal(result.status, "paid");
  assert.equal(result.verification, "signed-route-receipt-group-v1");
  assert.equal(result.slots[0].minimumDestinationAtoms, "1960000");
  assert.equal(result.slots[0].receivedAtoms, "1980000");
  assert.equal(result.slots[0].receipts.length, 2);
  assert.match(result.groupId, /^0x[0-9a-f]{64}$/);
  f.advance(1000);
  const replay = await f.create().status(f.input);
  assert.equal(replay.observedAtMs, at + 1000);
  assert.deepEqual({ ...replay, observedAtMs: at }, result);
});
test("missing unsigned members and pending routes never prove delivery", async () => {
  const f = await fixture();
  f.input.children[1] = null;
  assert.equal((await f.create().status(f.input)).status, "pending");
  assert.equal(f.commits.size, 0);
  const g = await fixture();
  g.setRoute("PROCESSING");
  assert.equal((await g.create().status(g.input)).status, "pending");
  assert.equal(g.commits.size, 0);
});
test("group rejects changed signed payload, wrong owners and duplicate nonce/deposit", async () => {
  for (const field of ["payload", "nonce", "deposit", "owner"]) {
    const f = await fixture(["private", "private"]);
    if (field === "payload") f.input.children[0].submittedIntent.payload += " ";
    if (field === "owner") f.input.owners = [];
    if (field === "nonce" || field === "deposit") {
      const q = f.quotes[1],
        p = JSON.parse(q.intent.payload);
      if (field === "nonce")
        p.nonce = JSON.parse(f.quotes[0].intent.payload).nonce;
      else {
        q.depositId = f.quotes[0].depositId;
        p.intents[0].receiver_id = q.depositId;
      }
      q.intent.payload = JSON.stringify(p);
      f.input.children[1].recoveryEnvelope = f.envelope.seal(
        "confidential-private-funding",
        q,
      );
      f.input.children[1].submittedIntent = await signed(q.intent.payload);
    }
    await assert.rejects(() => f.create().status(f.input), field);
  }
});
test("group rejects duplicate events, cross-group members, changed recipients and later gifts", async () => {
  const f = await fixture();
  await f.create().status(f.input);
  const mutated = structuredClone(f.input);
  mutated.group.journeyId = "journey_other";
  await assert.rejects(() => f.create().status(mutated));
  mutated.group.recipients[0] = "0x" + "99".repeat(20);
  await assert.rejects(() => f.create().status(mutated));
  f.events.push({ ...f.events[0]!, logIndex: 8, receivedAtoms: "1" });
  await assert.rejects(() => f.create().status(f.input));
  const g = await fixture();
  g.events.push(g.events[0]!);
  await assert.rejects(() => g.create().status(g.input));
});
test("insufficient receipt totals await receipt and do not freeze incomplete proof", async () => {
  const f = await fixture();
  const second = f.events.pop()!;
  assert.equal((await f.create().status(f.input)).status, "awaitingReceipt");
  f.events.push(second);
  assert.equal((await f.create().status(f.input)).status, "paid");
});
test("exact legacy private owner with purpose and intentHash remains recoverable without overwriting claims", async () => {
  const f = await fixture(["private"]);
  f.input.children[0].intentHash = "saved-provider-hash";
  const q = f.quotes[0];
  const owner = {
    purpose: "confidential-private-funding",
    operationId: q.operationId,
    source: C,
    recipient: R,
    payload: q.intent.payload,
    intentHash: "saved-provider-hash",
  };
  for (const event of f.events)
    await f.coordination.bind(
      "confidential-cashout-receipt",
      {
        chainId: 4663,
        token: ROBINHOOD_PROFILE.token,
        transactionHash: H,
        logIndex: event.logIndex,
      },
      owner,
      253402300799000,
    );
  assert.equal((await f.create().status(f.input)).status, "paid");
  const wrong = await fixture(["private"]);
  for (const event of wrong.events)
    await wrong.coordination.bind(
      "confidential-cashout-receipt",
      {
        chainId: 4663,
        token: ROBINHOOD_PROFILE.token,
        transactionHash: H,
        logIndex: event.logIndex,
      },
      { ...owner, operationId: "someone_else" },
      253402300799000,
    );
  await assert.rejects(() => wrong.create().status(wrong.input));
});

test("native group endpoint is private, bounded, no-store and sanitizes errors", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerEarnPayoutRoutes } =
    await import("../../../src/http/routes/earn-payout.routes.ts");
  const f = await fixture(),
    app = Fastify({ logger: false });
  registerEarnPayoutRoutes(app, f.funded, f.create());
  const ok = await app.inject({
    method: "POST",
    url: "/v1/earn/native/payout/group-status",
    payload: f.input,
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, "paid");
  assert.equal(ok.headers["cache-control"], "no-store");
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/earn/native/payout/group-status",
    payload: { secret: "private-signed-payload" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes("private-signed-payload"), false);
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/earn/native/payout/group-status",
    headers: { "content-type": "application/json" },
    payload: '{"secret-signed-body":',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("secret-signed-body"), false);
  const tooLarge = await app.inject({
    method: "POST",
    url: "/v1/earn/native/payout/group-status",
    payload: { secret: "A".repeat(8 * 1024 * 1024) },
  });
  assert.equal(tooLarge.statusCode, 413);
  await app.close();
});

test("Robinhood grouped receipt proves all transfers canonically without finalized RPC; Monad requires finality", async () => {
  const { confirmPayoutDestinationReceipt } =
    await import("../../../src/adapters/earn/private-payout.ts");
  const { encodeEventTopics, encodeAbiParameters, erc20Abi } =
    await import("viem");
  const q = (await fixture()).quotes[0];
  let chain = 4663,
    reorg = false,
    removed = false,
    future = false,
    wrongToken = false;
  const client: any = {
    getChainId: async () => chain,
    getTransactionReceipt: async () => ({
      transactionHash: H,
      status: "success",
      blockNumber: 101n,
      blockHash: B,
      logs: [0, 1].map((logIndex) => ({
        address: wrongToken ? R : ROBINHOOD_PROFILE.token,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: C as `0x${string}`, to: R as `0x${string}` },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [990000n]),
        logIndex,
        removed,
      })),
    }),
    getBlock: async (query: any) => {
      if (query.blockTag === "finalized") {
        if (chain === 4663) throw Error("Robinhood finality tag unavailable");
        return { number: 100n };
      }
      return {
        number: query.blockNumber,
        hash: reorg && query.blockNumber === 101n ? "0x" + "99".repeat(32) : B,
        timestamp: BigInt(at / 1000 + (future ? 100 : 0)),
      };
    },
  };
  const result = await confirmPayoutDestinationReceipt(
    client,
    q,
    H,
    undefined,
    true,
  );
  assert.equal(result.transfers.length, 2);
  await assert.rejects(() => confirmPayoutDestinationReceipt(client, q, H)); // exact-one route remains exact
  chain = 143;
  await assert.rejects(
    () =>
      confirmPayoutDestinationReceipt(
        client,
        { ...q, destinationChainId: 143 },
        H,
        undefined,
        true,
      ),
    /Noncanonical/,
  );
  chain = 4663;
  reorg = true;
  await assert.rejects(
    () => confirmPayoutDestinationReceipt(client, q, H, undefined, true),
    /Noncanonical/,
  );
  reorg = false;
  removed = true;
  await assert.rejects(() =>
    confirmPayoutDestinationReceipt(client, q, H, undefined, true),
  );
  removed = false;
  wrongToken = true;
  await assert.rejects(() =>
    confirmPayoutDestinationReceipt(client, q, H, undefined, true),
  );
  wrongToken = false;
  const gateway = new PrivatePayoutGateway({}, { now: () => at });
  (gateway as any).client = () => client;
  future = true;
  await assert.rejects(() => gateway.confirmEarnGroupReceipts(q, H), /Future/);
});

test("rejected later gifts and legacy conflicts leave no partial event or proof claims", async () => {
  const f = await fixture();
  await f.create().status(f.input);
  const gift = { ...f.events[0]!, logIndex: 19, receivedAtoms: "1" };
  f.events.push(gift);
  await assert.rejects(() => f.create().status(f.input));
  await f.coordination.bind(
    "confidential-cashout-receipt-group",
    {
      chainId: 4663,
      token: ROBINHOOD_PROFILE.token,
      transactionHash: H,
      logIndex: 19,
    },
    { other: "legitimate group" },
    253402300799000,
  );
});

test("a complete multi-slot source matrix counts each recipient independently and rejects missing sibling membership", async () => {
  const f = await fixture(["private", "private"]),
    recipient2 = "0x" + "aa".repeat(20),
    hash2 = "0x" + "bb".repeat(32);
  f.input.group.distribution.weightsBps = [5000, 5000];
  f.input.group.recipients.push(recipient2);
  f.input.group.members[1] = {
    operationId: "source_0",
    leg: "invest:1",
    kind: "private",
    recipient: recipient2,
  };
  const q = {
    ...f.quotes[1],
    operationId: "source_0_1",
    destinationRecipient: recipient2,
  };
  f.input.children[1].recoveryEnvelope = f.envelope.seal(
    "confidential-private-funding",
    q,
  );
  f.input.destinationTransactionHashes = [[H], [hash2]];
  const gateway = new module.EarnPayoutGroupGateway({
    coordination: f.coordination,
    privateGateway: f.privateGateway,
    fundedGateway: f.funded,
    now: () => at,
    confirmReceipts: async (_q: unknown, hash: string) => [
      { ...f.events[0]!, transactionHash: hash },
    ],
  });
  const result = await gateway.status(f.input);
  assert.equal(result.status, "paid");
  assert.equal(result.slots.length, 2);
  assert.equal(result.slots[1].destinationRecipient, recipient2);
  assert.equal(result.slots[1].minimumDestinationAtoms, "980000");
  f.input.children.pop();
  f.input.group.members.pop();
  await assert.rejects(() => gateway.status(f.input));
});

test("group digest is recursively canonical and includes the exact immutable review matrix", async () => {
  const f = await fixture();
  const reversed = (value: any): any =>
    Array.isArray(value)
      ? value.map(reversed)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([k, v]) => [k, reversed(v)]),
          )
        : value;
  assert.equal(
    module.earnPayoutGroupId(reversed(f.input.group)),
    module.earnPayoutGroupId(f.input.group),
  );
  const changed = structuredClone(f.input.group);
  changed.cycleIndex++;
  assert.notEqual(
    module.earnPayoutGroupId(changed),
    module.earnPayoutGroupId(f.input.group),
  );
});

test("group evidence sums whole recipient delivery without assigning events to children", async () => {
  const f = await fixture(["private", "private"]);
  f.events[0]!.receivedAtoms = "1";
  f.events[1]!.receivedAtoms = "1979999";
  const result = await f.create().status(f.input);
  assert.equal(result.status, "paid");
  assert.equal(result.slots[0].receivedAtoms, "1980000");
});

test("changed membership or an invalid seal cannot reserve any proof or global event", async () => {
  const f = await fixture();
  f.input.children[0].recoveryEnvelope += "changed";
  await assert.rejects(() => f.create().status(f.input));
  assert.equal(f.commits.size, 0);
  const g = await fixture();
  g.input.group.members[1]!.operationId = g.input.group.members[0]!.operationId;
  await assert.rejects(() => g.create().status(g.input));
  assert.equal(g.commits.size, 0);
});

test("mixed group uses production canonical ERC20 verifier with restored seals and no history", async () => {
  const { encodeEventTopics, encodeAbiParameters, erc20Abi } =
    await import("viem");
  const f = await fixture();
  // Replace only the transport boundary; retain the actual grouped receipt parser,
  // canonical/reference checks, signed restores, route reads and durable claims.
  (f.funded as any).client = () => ({
    getChainId: async () => 4663,
    getTransactionReceipt: async () => ({
      transactionHash: H,
      status: "success",
      blockNumber: 101n,
      blockHash: B,
      logs: [0, 1].map((logIndex) => ({
        address: ROBINHOOD_PROFILE.token,
        logIndex,
        removed: false,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: C as `0x${string}`, to: R as `0x${string}` },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [990000n]),
      })),
    }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: B,
      timestamp: BigInt(at / 1000),
    }),
  });
  const gateway = new module.EarnPayoutGroupGateway({
    coordination: f.coordination,
    privateGateway: f.privateGateway,
    fundedGateway: f.funded,
    now: () => at,
  });
  const result = await gateway.status(f.input);
  assert.equal(result.status, "paid");
  assert.equal(result.slots[0].receivedAtoms, "1980000");
  assert.equal(result.slots[0].receipts.length, 2);
});

test("a completed group cannot reserve an unauthenticated journey name for unrelated signed members", async () => {
  const f = await fixture();
  const ownerIdentity = {
    journeyId: f.input.group.journeyId,
    cycleIndex: f.input.group.cycleIndex,
  };
  await f.create().status(f.input);
  await f.coordination.bind(
    "earn-payout-group-membership",
    ownerIdentity,
    { groupId: "unrelated-authenticated-group" },
    253402300799000,
  );
});

test("production group verifier brackets distinct references across multiple child seals and hashes", async () => {
  const { encodeEventTopics, encodeAbiParameters, erc20Abi } =
    await import("viem");
  const f = await fixture();
  const hash2 = "0x" + "dd".repeat(32);
  f.input.destinationTransactionHashes = [[H, hash2]];
  let clients = 0,
    referenceReads = 0;
  const client = {
    getChainId: async () => 4663,
    getTransactionReceipt: async ({ hash }: { hash: string }) => ({
      transactionHash: hash,
      status: "success",
      blockNumber: 101n,
      blockHash: B,
      logs: [
        {
          address: ROBINHOOD_PROFILE.token,
          logIndex: 0,
          removed: false,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: C as `0x${string}`, to: R as `0x${string}` },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [990000n]),
        },
      ],
    }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber === 100n) referenceReads++;
      return { number: blockNumber, hash: B, timestamp: BigInt(at / 1000) };
    },
  };
  (f.funded as any).client = () => {
    clients++;
    return client;
  };
  const gateway = new module.EarnPayoutGroupGateway({
    coordination: f.coordination,
    privateGateway: f.privateGateway,
    fundedGateway: f.funded,
    now: () => at,
  });
  assert.equal((await gateway.status(f.input)).status, "paid");
  assert.equal(
    referenceReads,
    2,
    "duplicate source references are observed once before and once after the receipt batch",
  );
  assert.equal(clients, 1, "all receipts share the same request-scoped client");
});

test("request-scoped reference observations deduplicate anchors and reject stale or conflicting anchors", async () => {
  const f = await fixture(),
    reads = new Map<string, number>();
  let stale = false;
  (f.funded as any).client = () => ({
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const number = blockNumber.toString();
      reads.set(number, (reads.get(number) ?? 0) + 1);
      return { number: blockNumber, hash: stale ? "0x" + "ee".repeat(32) : B };
    },
  });
  const q = f.quotes[0],
    later = { ...q, referenceBlock: "102" };
  const verify = await f.funded.createEarnGroupReceiptVerifier([
    q,
    later,
    q,
    later,
  ]);
  assert.deepEqual(
    [...reads],
    [
      ["100", 1],
      ["102", 1],
    ],
  );
  await assert.rejects(
    () => verify({ ...q, referenceBlock: "103" }, H),
    /Unverified/,
  );
  await assert.rejects(
    () =>
      f.funded.createEarnGroupReceiptVerifier([
        q,
        { ...q, referenceHash: "0x" + "ff".repeat(32) },
      ]),
    /Conflicting/,
  );
  stale = true;
  await assert.rejects(
    () => f.funded.createEarnGroupReceiptVerifier([q]),
    /Changed group reference/,
  );
});

test("a canonical fork switch during grouped receipt reads rejects sampled ancestry before any claims", async () => {
  const { encodeEventTopics, encodeAbiParameters, erc20Abi } =
    await import("viem");
  const f = await fixture(),
    forkHash = "0x" + "fa".repeat(32);
  let switched = false,
    anchorReads = 0;
  (f.funded as any).client = () => ({
    getChainId: async () => 4663,
    getTransactionReceipt: async () => {
      // The saved anchor was canonical at initial sampling. The receipt is now
      // canonical on a different ancestry, without the saved reference hash.
      switched = true;
      return {
        transactionHash: H,
        status: "success",
        blockNumber: 101n,
        blockHash: forkHash,
        logs: [0, 1].map((logIndex) => ({
          address: ROBINHOOD_PROFILE.token,
          logIndex,
          removed: false,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: C as `0x${string}`, to: R as `0x${string}` },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [990000n]),
        })),
      };
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber === 100n) anchorReads++;
      return {
        number: blockNumber,
        hash: switched ? forkHash : B,
        timestamp: BigInt(at / 1000),
      };
    },
  });
  const gateway = new module.EarnPayoutGroupGateway({
    coordination: f.coordination,
    privateGateway: f.privateGateway,
    fundedGateway: f.funded,
    now: () => at,
  });
  await assert.rejects(
    () => gateway.status(f.input),
    /Changed group reference/,
  );
  assert.equal(switched, true);
  assert.equal(anchorReads, 2);
  assert.equal(
    f.commits.size,
    0,
    "no membership, event or frozen-proof claims survive a mid-request reorg",
  );
});
