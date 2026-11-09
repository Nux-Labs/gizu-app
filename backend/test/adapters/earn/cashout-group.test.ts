import test from "node:test";
import assert from "node:assert/strict";
import { ConfidentialCashoutGateway } from "../../../src/adapters/earn/confidential-cashout.ts";
import { OperationCoordinator } from "../../../src/adapters/earn/operation-coordinator.ts";
const C = "0x" + "1".repeat(40),
  D = "0x" + "3".repeat(40),
  R = "0x" + "2".repeat(40);
const asset = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
const at = Date.parse("2026-11-05T12:00:00Z");
function fixture() {
  const commitments = new Map<string, string>();
  const coordination = new OperationCoordinator(
    {
      bind: async (key, value) => {
        if (commitments.has(key) && commitments.get(key) !== value)
          return false;
        commitments.set(key, value);
        return true;
      },
    },
    "cd".repeat(32),
  );
  let serial = 0,
    initial = "0",
    clock = at;
  const routes = new Map<string, string>();
  const quotes = new Map<string, any>();
  const receipts = new Map<string, any[]>();
  const providers = {
    authenticate: async (auth: any) => auth.owner,
    balance: async (auth: any) => ({
      available: "9000000",
      confidentialAddress: auth.owner,
      assetId: asset,
      timestampMs: at,
      authenticated: true,
      operationScoped: false,
    }),
    quote: async (request: any) => {
      const deposit = `deposit-${++serial}`;
      quotes.set(deposit, request);
      routes.set(deposit, "SUCCESS");
      return {
        quoteRequest: request,
        signature: "provider",
        quote: {
          depositAddress: deposit,
          amountIn: request.amount,
          amountOut: request.amount,
          minAmountOut: (BigInt(request.amount) - 100n).toString(),
          deadline: new Date(at + 60000).toISOString(),
        },
      };
    },
    intent: async (source: string, deposit: string) => ({
      standard: "erc191",
      payload: JSON.stringify({
        signer_id: source,
        verifying_contract: "intents.far",
        nonce: Buffer.alloc(32, serial).toString("base64"),
        deadline: new Date(at + 60000).toISOString(),
        intents: [
          {
            intent: "transfer",
            receiver_id: deposit,
            tokens: {
              ["imt:" + "a".repeat(64) + ":" + asset]:
                quotes.get(deposit).amount,
            },
          },
        ],
      }),
    }),
    verify: async (intent: any) => JSON.parse(intent.payload).signer_id,
    history: async (): Promise<any[]> => {
      throw Error("No private history");
    },
    reference: async () => ({
      referenceBlock: "100",
      referenceHash: "0x" + "a".repeat(64),
      initialDestinationAtoms: initial,
    }),
    routeStatus: async (deposit: string) => ({ status: routes.get(deposit) }),
    confirm: async () => {
      throw Error("No per-child receipt");
    },
    confirmGroupReceipts: async (_q: any, hash: string) => receipts.get(hash)!,
  };
  const create = () =>
    new ConfidentialCashoutGateway(
      { recoveryKey: "ab".repeat(32), coordination },
      providers,
      () => clock,
    );
  const group = {
    plan: {
      proposal: {
        operationId: "cash_group",
        amountAtoms: "3000000",
        sources: [
          {
            kind: "swap",
            profileChainId: 0,
            cycleIndex: 0,
            address: C,
            amountAtoms: "1000000",
          },
          {
            kind: "earn",
            profileChainId: 4663,
            cycleIndex: 0,
            address: D,
            amountAtoms: "2000000",
          },
        ],
        recipientIndices: [3],
        weightsBps: [10000],
      },
      children: [
        { source: 0, slot: 0, amountAtoms: "1000000" },
        { source: 1, slot: 0, amountAtoms: "2000000" },
      ],
    },
    recipients: [R],
  };
  const prepare = (index: number, anchor?: string) =>
    create().prepareGroup({
      group,
      childIndex: index,
      signedData: { owner: index === 0 ? C : D },
      anchor,
    });
  const request = (prepared: any[]) => ({
    group,
    owners: [{ owner: C }, { owner: D }],
    children: prepared.map((q) => ({
      recoveryEnvelope: q.recoveryEnvelope,
      submittedIntent: { ...q.intent, signature: "signed" },
    })),
    destinationTransactionHashes: [[]] as string[][],
  });
  const add = (digit: string, amount: string, logIndex = 0) => {
    const hash = "0x" + digit.repeat(64);
    receipts.set(hash, [
      {
        transactionHash: hash,
        receivedAtoms: amount,
        logIndex,
        blockNumber: "101",
        blockHash: "0x" + "b".repeat(64),
      },
    ]);
    return hash;
  };
  return {
    create,
    group,
    prepare,
    request,
    add,
    receipts,
    routes,
    commitments,
    coordination,
    providers,
    advance: (ms: number) => {
      clock += ms;
    },
    funded: () => {
      initial = "500000";
    },
  };
}
test("shared receiving slot confirms unequal source routes as one public delivery group", async () => {
  const f = fixture();
  const a = await f.prepare(0);
  const b = await f.prepare(1);
  const request = f.request([a, b]);
  assert.equal(
    (await f.create().groupStatus(request)).status,
    "awaitingReceipt",
  );
  // Neither event has to match an individual private source's minimum.
  request.destinationTransactionHashes = [
    [f.add("1", "500000"), f.add("2", "2500123")],
  ];
  const paid = await f.create().groupStatus(request);
  assert.equal(paid.status, "paid");
  assert.equal(paid.slots[0].receivedAtoms, "3000123");
  assert.equal(paid.slots[0].receipts.length, 2);
  assert.deepEqual(await f.create().groupStatus(request), paid);
  assert.ok(
    [...f.commitments].every(
      ([key, value]) =>
        /^[0-9a-f]{64}$/.test(key) && /^[0-9a-f]{64}$/.test(value),
    ),
  );
});
test("same saved plan can refresh an unsigned child after shared R was funded using its sealed zero anchor", async () => {
  const f = fixture();
  const a = await f.prepare(0);
  f.funded();
  const b = await f.prepare(1, a.recoveryEnvelope);
  assert.equal(b.initialDestinationAtoms, "0");
  assert.equal(b.referenceBlock, a.referenceBlock);
  await assert.rejects(f.prepare(1), /Fresh|anchor/);
  f.group.plan.proposal.operationId = "other";
  await assert.rejects(f.prepare(1, a.recoveryEnvelope), /Changed|binding/);
});
test("group confirmation requires every exact signed child, owner and successful route", async () => {
  for (const change of [
    "missing",
    "owner",
    "payload",
    "pending",
    "minimum",
    "duplicate",
  ]) {
    const f = fixture();
    const a = await f.prepare(0),
      b = await f.prepare(1);
    const request = f.request([a, b]);
    const hash = f.add("1", change === "minimum" ? "2999799" : "3000100");
    request.destinationTransactionHashes = [[hash]];
    if (change === "missing") request.children.pop();
    if (change === "owner") request.owners[1] = { owner: C };
    if (change === "payload")
      request.children[1]!.submittedIntent.payload += " ";
    if (change === "pending") f.routes.set(b.depositId, "PROCESSING");
    if (change === "duplicate")
      request.destinationTransactionHashes[0]!.push(hash);
    if (change === "pending" || change === "minimum")
      assert.notEqual((await f.create().groupStatus(request)).status, "paid");
    else await assert.rejects(f.create().groupStatus(request), /./, change);
  }
});
test("permanent recipient membership rejects another plan and source allocation", async () => {
  const f = fixture();
  await f.prepare(0);
  f.group.plan.proposal.operationId = "other";
  await assert.rejects(f.prepare(0), /consumed/);
});
test("partly signed plan reports successful saved routes without demanding unsigned children", async () => {
  const f = fixture();
  const a = await f.prepare(0),
    b = await f.prepare(1);
  const request: any = f.request([a, b]);
  request.children[1] = null;
  const status = await f.create().groupStatus(request);
  assert.equal(status.status, "pending");
  assert.deepEqual(status.routes, [{ index: 0, status: "SUCCESS" }]);
  f.funded();
  const refreshed = await f.prepare(1, a.recoveryEnvelope);
  const full = f.request([a, refreshed]);
  full.destinationTransactionHashes = [[f.add("1", "3000001")]];
  assert.equal((await f.create().groupStatus(full)).status, "paid");
});

test("saved legacy receipts migrate only through their exact group member commitment", async () => {
  for (const mode of ["receipt", "known-history", "unknown-history"]) {
    const f = fixture();
    const prepared: any[] = [];
    for (const [i, source] of [C, D].entries())
      prepared.push(
        await f.create().prepare(
          {
            operationId: `cash_group_${i}`,
            signedData: { owner: source },
            recipient: R,
            amountAtoms: i === 0 ? "1000000" : "2000000",
          },
          i === 0,
        ),
      );
    const hash = f.add("1", "999900");
    const second = f.add("2", "2000123");
    const owner = {
      operationId: prepared[0].operationId,
      source: C,
      recipient: R,
      payload: prepared[0].intent.payload,
    };
    await f.coordination.bind(
      "confidential-cashout-receipt",
      {
        chainId: 143,
        token: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        transactionHash: hash,
        logIndex: 0,
      },
      mode === "receipt"
        ? { verification: "destination-receipt-v1", ...owner }
        : { ...owner, intentHash: "original" },
      253402300799000,
    );
    const request: any = f.request(prepared);
    request.destinationTransactionHashes = [[second, hash]];
    if (mode === "known-history") request.children[0].intentHash = "original";
    if (mode === "unknown-history")
      await assert.rejects(f.create().groupStatus(request), /consumed/);
    else {
      const paid = await f.create().groupStatus(request);
      assert.equal(paid.status, "paid");
      assert.equal(paid.slots[0].receivedAtoms, "3000023");
      assert.deepEqual(await f.create().groupStatus(request), paid);
    }
  }
});
test("one event cannot be counted by another group even if its receipt provider returns it", async () => {
  const f = fixture();
  const first = f.request([await f.prepare(0), await f.prepare(1)]);
  first.destinationTransactionHashes = [[f.add("1", "3000100")]];
  assert.equal((await f.create().groupStatus(first)).status, "paid");
  f.group.plan.proposal.operationId = "cash_other";
  f.group.recipients = ["0x" + "4".repeat(40)];
  const second = f.request([await f.prepare(0), await f.prepare(1)]);
  second.destinationTransactionHashes = first.destinationTransactionHashes;
  await assert.rejects(f.create().groupStatus(second), /consumed/);
});
test("group with all signed routes preserves exact signed children against later quote replacement", async () => {
  const f = fixture();
  const a = await f.prepare(0),
    b = await f.prepare(1);
  const original = f.request([a, b]);
  assert.equal(
    (await f.create().groupStatus(original)).status,
    "awaitingReceipt",
  );
  const changed = f.request([a, await f.prepare(1, a.recoveryEnvelope)]);
  await assert.rejects(f.create().groupStatus(changed), /consumed/);
  original.destinationTransactionHashes = [[f.add("1", "3000100")]];
  assert.equal((await f.create().groupStatus(original)).status, "paid");
});
test("duplicate event in canonical provider response is never added twice", async () => {
  const f = fixture();
  const request = f.request([await f.prepare(0), await f.prepare(1)]);
  const hash = f.add("1", "1500000");
  f.receipts.get(hash)!.push({ ...f.receipts.get(hash)![0] });
  request.destinationTransactionHashes = [[hash]];
  await assert.rejects(f.create().groupStatus(request), /Duplicate/);
});

test("group endpoints require explicit negotiated proof and bounded complete membership", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerConfidentialCashoutRoutes } =
    await import("../../../src/http/routes/confidential-cashout.routes.ts");
  const f = fixture();
  const gateway = f.create();
  const app = Fastify({ logger: false });
  // Signed read transport carries an owner in the payload; fixture replaces only cryptographic/RPC boundaries.
  f.providers.authenticate = async (auth: any) => auth.payload;
  const balance = f.providers.balance;
  f.providers.balance = async (auth: any) => balance({ owner: auth.payload });
  registerConfidentialCashoutRoutes(app, gateway);
  const signed = (owner: string) => ({
    standard: "erc191",
    payload: owner,
    signature: "secp256k1:" + "1".repeat(87),
  });
  try {
    const body = { group: f.group, childIndex: 0, signedData: signed(C) };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-prepare",
      payload: body,
    });
    assert.equal(denied.statusCode, 400);
    const headers = { "x-gizu-payout-proof": "destination-receipt-group-v1" };
    const a = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-prepare",
      headers,
      payload: body,
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-prepare",
      headers,
      payload: { ...body, childIndex: 1, signedData: signed(D) },
    });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(a.headers["cache-control"], "no-store");
    const request = f.request([a.json(), b.json()]);
    request.owners = [signed(C), signed(D)] as any;
    for (const child of request.children)
      child.submittedIntent.signature = signed(C).signature;
    request.destinationTransactionHashes = [[f.add("1", "3000100")]];
    const paid = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-status",
      headers,
      payload: request,
    });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().status, "paid");
    assert.equal(paid.json().verification, "destination-receipt-group-v1");
    const tooMany = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-status",
      headers,
      payload: {
        ...request,
        owners: Array.from({ length: 33 }, () => signed(C)),
      },
    });
    assert.equal(tooMany.statusCode, 400);
    const downgrade = await app.inject({
      method: "POST",
      url: "/v1/earn/native/cashout/group-status",
      headers: { "x-gizu-payout-proof": "destination-receipt-v1" },
      payload: request,
    });
    assert.equal(downgrade.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("maximum 32-source five-receiver matrix is verified in bounded read batches", async () => {
  const f = fixture();
  const p = f.group.plan.proposal;
  p.sources = Array.from({ length: 32 }, (_, i) => ({
    kind: i === 0 ? "swap" : "earn",
    profileChainId: i === 0 ? 0 : 4663,
    cycleIndex: i,
    address: "0x" + (100 + i).toString(16).padStart(40, "0"),
    amountAtoms: "1000000",
  }));
  p.amountAtoms = "32000000";
  p.weightsBps = [2000, 2000, 2000, 2000, 2000];
  p.recipientIndices = [3, 4, 5, 6, 7];
  f.group.recipients = [4, 5, 6, 7, 8].map(
    (i) => "0x" + i.toString().repeat(40),
  );
  f.group.plan.children = [];
  const budgets = Array<bigint>(5).fill(6400000n);
  let slot = 0;
  for (let source = 0; source < 32; source++) {
    let left = 1000000n;
    while (left > 0n) {
      const n = left < budgets[slot]! ? left : budgets[slot]!;
      f.group.plan.children.push({ source, slot, amountAtoms: n.toString() });
      left -= n;
      budgets[slot]! -= n;
      if (budgets[slot] === 0n) slot++;
    }
  }
  assert.equal(f.group.plan.children.length, 36);
  const prepared: any[] = [];
  for (const [i, c] of f.group.plan.children.entries())
    prepared.push(
      await f.create().prepareGroup({
        group: f.group,
        childIndex: i,
        signedData: { owner: p.sources[c.source]!.address },
      }),
    );
  const request = f.request(prepared);
  request.owners = p.sources.map((s) => ({ owner: s.address }));
  request.destinationTransactionHashes = f.group.recipients.map((_, slot) => [
    f.add(
      (slot + 1).toString(),
      (
        prepared
          .filter((_, i) => f.group.plan.children[i]!.slot === slot)
          .reduce((n, q) => n + BigInt(q.minimumDestinationAtoms), 0n) + 123n
      ).toString(),
    ),
  ]);
  let active = 0,
    peak = 0;
  const status = f.providers.routeStatus;
  f.providers.routeStatus = async (d) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    f.advance(1000);
    active--;
    return status(d);
  };
  const result = await f.create().groupStatus(request);
  assert.equal(result.status, "paid");
  assert.equal(result.slots.length, 5);
  assert.equal(peak, 4);
  assert.equal(result.observedAtMs, at + 36000);
});
test("one private nonce cannot represent two signed children in the same source", async () => {
  const f = fixture();
  const p = f.group.plan.proposal;
  p.sources = [{ ...p.sources[0]!, amountAtoms: "3000000" }];
  p.weightsBps = [5000, 5000];
  p.recipientIndices = [3, 4];
  f.group.recipients = [R, "0x" + "4".repeat(40)];
  f.group.plan.children = [
    { source: 0, slot: 0, amountAtoms: "1500000" },
    { source: 0, slot: 1, amountAtoms: "1500000" },
  ];
  const intent = f.providers.intent;
  f.providers.intent = async (s, d) => {
    const value = await intent(s, d);
    const payload = JSON.parse(value.payload);
    payload.nonce = Buffer.alloc(32, 1).toString("base64");
    return { ...value, payload: JSON.stringify(payload) };
  };
  const prepared: any[] = [];
  for (let i = 0; i < 2; i++)
    prepared.push(
      await f.create().prepareGroup({
        group: f.group,
        childIndex: i,
        signedData: { owner: C },
      }),
    );
  const request = f.request(prepared);
  request.owners = [{ owner: C }];
  request.destinationTransactionHashes = [[], []];
  await assert.rejects(
    f.create().groupStatus(request),
    /Duplicate signed child nonce/,
  );
});
