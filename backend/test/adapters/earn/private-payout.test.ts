import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgOperationCoordination } from "../../../src/adapters/postgres/pg-operation-coordination.ts";
import { OperationCoordinator } from "../../../src/adapters/earn/operation-coordinator.ts";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, toHex, keccak256 } from "viem";
import { base58 } from "@scure/base";
import { EarnRecoveryEnvelope } from "../../../src/adapters/earn/recovery-envelope.ts";
import {
  PrivatePayoutGateway,
  boundUnsignedPayoutDeadline,
  type WithdrawalPrepareInput,
} from "../../../src/adapters/earn/private-payout.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
const now = Date.parse("2026-09-30T10:00:00.000Z");
const account = privateKeyToAccount(
  ("0x" + "00".repeat(31) + "01") as `0x${string}`,
);
const C = account.address.toLowerCase(),
  sourceOwner = "0x" + "22".repeat(20),
  sourceDeposit = "0x" + "33".repeat(20),
  sourceTx = "0x" + "44".repeat(32),
  hold = "0x" + "55".repeat(20),
  invest = "0x" + "66".repeat(20),
  blockHash = "0x" + "77".repeat(32),
  privateId = "imt:" + "88".repeat(32) + ":" + monadUsdcAssetId;
const qualification = {
  protocolFeeBps: 2 as const,
  appFees: [{ recipient: "actual-provider.near", fee: 2 as const }],
  referral: null,
};
async function signature(payload: string) {
  const bytes = hexToBytes(await account.signMessage({ message: payload }));
  bytes[64]! -= 27;
  return "secp256k1:" + base58.encode(bytes);
}
async function readAuth(clock = now) {
  const nonce = Buffer.alloc(32);
  Buffer.from("5628f6c600", "hex").copy(nonce);
  nonce.writeBigUInt64LE(BigInt(clock + 300000) * 1000000n, 9);
  nonce.writeBigUInt64LE(BigInt(clock) * 1000000n, 17);
  const payload = JSON.stringify({
    deadline: new Date(clock + 300000).toISOString(),
    intents: [],
    nonce: nonce.toString("base64"),
    signer_id: C,
    verifying_contract: "intents.near",
  });
  return {
    standard: "erc191" as const,
    payload,
    signature: await signature(payload),
  };
}
async function input(
  leg: "hold" | "invest" = "hold",
  profileChainId: 1 | 4663 = 1,
) {
  return {
    operationId: "source_1",
    revision: 1,
    profileChainId,
    leg,
    recipient: leg === "hold" ? hold : invest,
    signedData: await readAuth(),
    source: {
      operationId: "source_1",
      revision: 1,
      quoteId: "0x" + "99".repeat(32),
      depositAddress: sourceDeposit,
      sourceOwner,
      confidentialAccount: C,
      originAsset: monadUsdcAssetId as typeof monadUsdcAssetId,
      amountAtoms: "1000000",
      minimumCreditAtoms: "990000",
      transactionHash: sourceTx,
    },
  };
}
function balanceAttestedSource<T extends { quoteId: string; revision: number }>(
  source: T,
  operationHistory = false,
) {
  const fields = Object.fromEntries(
    Object.entries(source).filter(
      ([k]) => !["quoteId", "revision", "routeKind"].includes(k),
    ),
  );
  const binding = {
    ...fields,
    baselineEnvelope: "saved-baseline",
    quoteEnvelope: "saved-quote",
    maximumCreditAtoms: operationHistory ? "995000" : "995001",
  };
  const canonical = Object.fromEntries(
    Object.entries(binding)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [
        k,
        typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v,
      ]),
  );
  return {
    ...source,
    baselineEnvelope: binding.baselineEnvelope,
    quoteEnvelope: binding.quoteEnvelope,
    maximumCreditAtoms: binding.maximumCreditAtoms,
    settlementEnvelope: new EarnRecoveryEnvelope("11".repeat(32)).seal(
      "source-credit",
      {
        binding: canonical,
        proof: {
          status: "credited",
          creditedAtoms: "995001",
          ...(operationHistory ? { verification: "operation-history-v1" } : {}),
        },
      },
    ),
  };
}

test("history-attested better execution supports source preparation and recovery without exposing negotiation fields", async () => {
  const f = fixture((path) => {
    if (path.includes("/account/history/"))
      throw Error("Saved authenticated evidence must be reused");
  });
  const request = await input();
  const source = balanceAttestedSource(request.source, true);
  const prepared = await f.gateway.prepare({ ...request, source });
  assert.equal(prepared.sourceCredit.creditedAtoms, "995001");
  assert.equal(source.maximumCreditAtoms, "995000");
  const recovered = await f
    .restart()
    .prepare({
      ...request,
      source,
      recoveryEnvelope: prepared.recoveryEnvelope,
    });
  assert.equal(recovered.sourceCredit.creditedAtoms, "995001");
  assert.equal(
    f.calls.some((path) => path.includes("/account/history/")),
    false,
  );
});
function fixture(
  mutate?: (path: string, body: any, init?: RequestInit) => void,
  profileChainId: 1 | 4663 = 1,
  recoveryKey: string | null = "11".repeat(32),
  coordination?: import("../../../src/adapters/earn/operation-coordinator.ts").OperationCoordinator,
  initialClock = now,
) {
  let clock = initialClock;
  const calls: string[] = [];
  let quotes = 0;
  let lastRequest: any;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push(path);
    const rpc = path === "https://ethereum.test/";
    let body: any;
    if (rpc) {
      const req = JSON.parse(String(init?.body));
      const result =
        req.method === "eth_chainId"
          ? toHex(profileChainId)
          : req.method === "eth_getCode"
            ? "0x6000"
            : req.method === "eth_call"
              ? toHex(req.params[0].data.startsWith("0x313ce567") ? 6n : 0n, {
                  size: 32,
                })
              : {
                  number: "0x64",
                  hash: blockHash,
                  timestamp: toHex(BigInt(clock / 1000)),
                  baseFeePerGas: "0x1",
                  gasLimit: "0x1c9c380",
                  gasUsed: "0x0",
                  transactions: [],
                  parentHash: "0x" + "00".repeat(32),
                };
      body = { jsonrpc: "2.0", id: req.id, result };
    } else if (path.includes("/auth/authenticate/"))
      body = { accessToken: "private-jwt" };
    else if (path.includes("/account/history/"))
      body = {
        items: [
          {
            status: "SUCCESS",
            depositType: "ORIGIN_CHAIN",
            recipientType: "CONFIDENTIAL_INTENTS",
            refundType: "ORIGIN_CHAIN",
            createdAt: new Date(now - 1000).toISOString(),
            depositAddress: sourceDeposit,
            originAsset: monadUsdcAssetId,
            destinationAsset: monadUsdcAssetId,
            recipient: C,
            refundTo: sourceOwner,
            amountInFormatted: "1",
            amountOutFormatted: "0.995001",
            quoteTransactions: [{ sender: sourceOwner, txHash: sourceTx }],
          },
        ],
      };
    else if (path.includes("/quote/")) {
      quotes++;
      lastRequest = JSON.parse(String(init?.body));
      body = {
        timestamp: new Date(clock).toISOString(),
        signature: "provider-quote-signature",
        quoteRequest: {
          ...lastRequest,
          appFees: qualification.appFees,
          referral: null,
        },
        quote: {
          depositAddress: "payout-" + quotes + ".near",
          amountIn: lastRequest.amount,
          minAmountIn: lastRequest.amount,
          amountOut: lastRequest.amount,
          minAmountOut: lastRequest.amount,
          deadline: lastRequest.deadline,
          timeWhenInactive: lastRequest.deadline,
          refundFee: "0",
          withdrawFee: "0",
        },
      };
    } else if (path.includes("/generate-intent/")) {
      const req = JSON.parse(String(init?.body));
      body = {
        intent: {
          standard: "erc191",
          payload: JSON.stringify({
            signer_id: C,
            verifying_contract: "intents.far",
            nonce: Buffer.alloc(32, quotes).toString("base64"),
            deadline: lastRequest.deadline,
            intents: [
              {
                intent: "transfer",
                receiver_id: req.depositAddress,
                tokens: { [privateId]: lastRequest.amount },
              },
            ],
          }),
        },
      };
    } else if (path.includes("/submit-intent/"))
      body = { intentHash: base58.encode(Buffer.alloc(32, 7)) };
    else if (path.includes("/status/")) body = { status: "SUCCESS" };
    else throw new Error("Unexpected mocked request");
    mutate?.(path, body, init);
    return new Response(JSON.stringify(body));
  };
  const restart = () =>
    new PrivatePayoutGateway(
      {
        auroraApiKey: "server-key",
        auroraFeeQualification: qualification,
        ethereumRpcUrl: "https://ethereum.test",
        robinhoodRpcUrl: "https://ethereum.test",
        monadRpcUrl: "https://ethereum.test",
        recoveryKey: recoveryKey ?? undefined,
        coordination,
      },
      { fetcher, now: () => clock },
    );
  return {
    gateway: restart(),
    restart,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}
async function distributionInput(
  slot: 0 | 1 | 2 | 3 | 4 = 0,
  weightsBps = [3333, 3333, 3334],
) {
  return {
    ...(await input("invest")),
    leg: `invest:${slot}` as `invest:${0 | 1 | 2 | 3 | 4}`,
    recipient: "0x" + (slot + 6).toString(16).repeat(40),
    distribution: { version: 1 as const, weightsBps },
  };
}
test("distribution payouts conserve fragmented credits across one, two and five investment slots", async () => {
  for (const [weights, expected] of [
    [[10000], ["200018"]],
    [
      [3333, 6667],
      ["66665", "133353"],
    ],
    [
      [2000, 2000, 2000, 2000, 2000],
      ["40003", "40003", "40003", "40003", "40006"],
    ],
  ] as const) {
    const totals = weights.map(() => 0n);
    for (const offset of ["0", "100009"]) {
      const f = fixture((path, body) => {
        if (path.includes("/account/history/"))
          body.items[0].amountOutFormatted = "0.100009";
      });
      let sourceTotal = 0n;
      for (let slot = 0; slot < weights.length; slot++) {
        const request = await distributionInput(slot as 0 | 1 | 2 | 3 | 4, [
          ...weights,
        ]);
        request.source.minimumCreditAtoms = "100000";
        const plan = await f.gateway.prepare({
          ...request,
          splitOffsetAtoms: offset,
        });
        assert.deepEqual(plan.quote.distribution, request.distribution);
        assert.equal(plan.quote.leg, `invest:${slot}`);
        sourceTotal += BigInt(plan.quote.amountAtoms);
        totals[slot]! += BigInt(plan.quote.amountAtoms);
      }
      assert.equal(sourceTotal, 100009n);
    }
    assert.deepEqual(totals.map(String), expected);
  }
});
test("distribution sibling prepare, submit and restored retries retain independent identities", async () => {
  const f = fixture();
  const requests = [await distributionInput(0), await distributionInput(1)];
  const plans = [];
  for (const request of requests) plans.push(await f.gateway.prepare(request));
  assert.notEqual(plans[0]!.quote.quoteId, plans[1]!.quote.quoteId);
  assert.equal(
    (await f.gateway.prepare(requests[0]!)).quote.quoteId,
    plans[0]!.quote.quoteId,
  );
  const restarted = f.restart();
  for (const plan of plans) {
    const request = {
      operationId: plan.quote.operationId,
      revision: 1,
      leg: plan.quote.leg as `invest:${0 | 1 | 2 | 3 | 4}`,
      distribution: requests[0]!.distribution,
      quoteId: plan.quote.quoteId,
      recoveryEnvelope: plan.recoveryEnvelope,
      signedData: {
        ...plan.intent,
        signature: await signature(plan.intent.payload),
      },
    };
    const submitted = await restarted.submit(request);
    assert.equal(submitted.leg, request.leg);
    assert.deepEqual(submitted.distribution, request.distribution);
    assert.deepEqual(await restarted.submit(request), submitted);
    const settlement = await restarted.reconcile({
      ...request,
      signedData: await readAuth(),
    });
    assert.equal(settlement.leg, request.leg);
    assert.deepEqual(settlement.distribution, request.distribution);
    await assert.rejects(
      restarted.submit({
        ...request,
        distribution: { version: 1, weightsBps: [2500, 2500, 5000] },
      }),
    );
    await assert.rejects(
      restarted.reconcile({
        ...request,
        signedData: await readAuth(),
        distribution: { version: 1, weightsBps: [2500, 2500, 5000] },
      }),
    );
    await assert.rejects(
      restarted.submit({ ...request, distribution: undefined }),
    );
  }
  assert.equal(
    f.calls.filter((path) => path.includes("/submit-intent/")).length,
    2,
  );
});
test("distribution fanout has a separate bounded request budget while legacy retains thirty per minute", async () => {
  const f = fixture();
  const request = await distributionInput();
  request.source = balanceAttestedSource(request.source);
  const plan = await f.gateway.prepare(request, "shared-client");
  const submission = {
    operationId: request.operationId,
    revision: 1,
    leg: request.leg,
    distribution: request.distribution,
    quoteId: plan.quote.quoteId,
    recoveryEnvelope: plan.recoveryEnvelope,
    signedData: {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    },
  };
  await f.gateway.submit(submission, "shared-client");
  const settlement = {
    ...submission,
    signedData: await readAuth(),
    submittedIntent: submission.signedData,
  };
  await f.gateway.reconcile(settlement, "shared-client");
  // Prepare + submit + settlement and 147 exact retries exhaust a 30 * 5 slot budget.
  for (let i = 0; i < 147; i++)
    assert.equal(
      (await f.gateway.submit(submission, "shared-client")).status,
      "submitted",
    );
  await assert.rejects(
    f.gateway.reconcile(settlement, "shared-client"),
    /EARN_PAYOUT_RATE_LIMIT/,
  );
  await assert.rejects(
    f.gateway.prepare(request, "shared-client"),
    /EARN_PAYOUT_RATE_LIMIT/,
  );
  const legacy = await input();
  legacy.operationId = "legacy_source";
  legacy.source = balanceAttestedSource({
    ...legacy.source,
    operationId: legacy.operationId,
    transactionHash: "0x" + "cd".repeat(32),
  });
  for (let i = 0; i < 30; i++)
    assert.equal(
      (await f.gateway.prepare(legacy, "shared-client")).quote.leg,
      "hold",
    );
  await assert.rejects(
    f.gateway.prepare(legacy, "shared-client"),
    /EARN_PAYOUT_RATE_LIMIT/,
  );
  // Invalid metadata never enters either validated request budget.
  for (let i = 0; i < 160; i++)
    await assert.rejects(
      f.gateway.prepare(
        { ...request, distribution: { version: 1, weightsBps: [9999] } },
        "shared-client",
      ),
      /INVALID_PAYOUT_REQUEST/,
    );
  f.advance(60000);
  assert.equal(
    (await f.gateway.submit(submission, "shared-client")).status,
    "submitted",
  );
  assert.equal(
    (await f.gateway.prepare(legacy, "shared-client")).quote.leg,
    "hold",
  );
});
test("distribution plans reject malformed weights, legacy legs, slot mismatches and changed saved plans", async () => {
  const valid = await distributionInput();
  for (const distribution of [
    { version: 2, weightsBps: [10000] },
    { version: 1, weightsBps: [] },
    { version: 1, weightsBps: [10000, 0] },
    { version: 1, weightsBps: [-1, 10001] },
    { version: 1, weightsBps: [5000.5, 4999.5] },
    { version: 1, weightsBps: [9999] },
    { version: 1, weightsBps: [1000, 1000, 1000, 1000, 1000, 5000] },
    { version: 1, weightsBps: [10000], extra: true },
  ])
    await assert.rejects(
      fixture().gateway.prepare({ ...valid, distribution } as never),
      /INVALID_PAYOUT_REQUEST/,
    );
  for (const invalid of [
    { ...valid, leg: "invest" },
    { ...valid, leg: "hold" },
    { ...valid, leg: "invest:3" },
    { ...valid, distribution: undefined },
    { ...valid, recipient: sourceOwner },
  ])
    await assert.rejects(fixture().gateway.prepare(invalid as never));
  const f = fixture();
  await f.gateway.prepare(valid);
  await assert.rejects(
    f.gateway.prepare({
      ...valid,
      leg: "invest:1",
      distribution: { version: 1, weightsBps: [2500, 2500, 5000] },
    }),
    /EARN_PAYOUT_CREDIT_BOUND/,
  );
  await assert.rejects(
    f.gateway.prepare(await input()),
    /EARN_PAYOUT_CREDIT_BOUND/,
  );
});
test("distribution status reconciliation preserves the plan on subsequent signed retries", async () => {
  const request = await distributionInput(0, [10000]);
  const f = deliveredFixture((path, body) => {
    if (
      path.includes("/account/history/") &&
      new URL(path).searchParams.get("depositAddress") === "payout-1.near"
    ) {
      body.items[0].recipient = request.recipient;
      body.items[0].amountInFormatted = "0.995001";
      body.items[0].amountOutFormatted = "0.995001";
    }
  });
  const plan = await f.gateway.prepare(request);
  const submission = {
    operationId: request.operationId,
    revision: 1,
    leg: request.leg,
    distribution: request.distribution,
    quoteId: plan.quote.quoteId,
    signedData: {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    },
  };
  await f.gateway.submit(submission);
  const result = await f.gateway.reconcile({
    ...submission,
    signedData: await readAuth(),
  });
  assert.equal(result.status, "awaitingDestinationConfirmation");
  assert.deepEqual(result.distribution, request.distribution);
  assert.deepEqual(
    (await f.gateway.submit(submission)).distribution,
    request.distribution,
  );
});
test("distribution zero and decreasing remainder allocations fail before provider quote generation", async () => {
  for (const [slot, weights, offset] of [
    [0, [1, 9999], "0"],
    [0, [3333, 3333, 3334], "3"],
    [2, [3333, 3333, 3334], "3"],
    [4, [2499, 2499, 2499, 2499, 4], "4"],
  ] as const) {
    const f = fixture((path, body) => {
      if (path.includes("/account/history/"))
        body.items[0].amountOutFormatted = "0.000001";
    });
    const request = await distributionInput(slot, [...weights]);
    request.source.minimumCreditAtoms = "1";
    await assert.rejects(
      f.gateway.prepare({ ...request, splitOffsetAtoms: offset }),
    );
    assert.equal(
      f.calls.some((path) => path.includes("/quote/")),
      false,
    );
  }
});
test("payout preparation derives exact split from authenticated actual credit, validates generated transfer and is immutable", async () => {
  const f = fixture();
  const holdPlan = await f.gateway.prepare(await input());
  const investPlan = await f.gateway.prepare(await input("invest"));
  assert.equal(holdPlan.sourceCredit.creditedAtoms, "995001");
  assert.equal(holdPlan.quote.amountAtoms, "99500");
  assert.equal(investPlan.quote.amountAtoms, "895501");
  assert.equal(holdPlan.quote.privateTokenId, privateId);
  assert.equal(holdPlan.quote.destinationAsset, ethereumUsdcAssetId);
  assert.equal(holdPlan.nativeJournalRequired, true);
  assert.equal(
    holdPlan.nonceVerification,
    "provider-generated-journal-uniqueness-required",
  );
  assert.ok(Object.isFrozen(holdPlan));
  assert.equal(JSON.stringify(holdPlan).includes("private-jwt"), false);
  assert.equal(
    (await f.gateway.prepare(await input())).quote.quoteId,
    holdPlan.quote.quoteId,
  );
  assert.equal(
    f.calls.filter((p) => p.includes("/generate-intent/")).length,
    2,
  );
});
test("wrong generated signer, contract, token, amount, receiver and extra intents are rejected", async () => {
  for (const change of [
    (m: any) => (m.signer_id = hold),
    (m: any) => (m.verifying_contract = "intents.near"),
    (m: any) => (m.intents[0].tokens = { [privateId]: "1" }),
    (m: any) => (m.intents[0].receiver_id = "wrong.near"),
    (m: any) => m.intents.push(m.intents[0]),
    (m: any) => (m.extra = true),
  ]) {
    const f = fixture((path, b) => {
      if (path.includes("/generate-intent/")) {
        const m = JSON.parse(b.intent.payload);
        change(m);
        b.intent.payload = JSON.stringify(m);
      }
    });
    await assert.rejects(f.gateway.prepare(await input()));
  }
});
test("changed provider fees or source history cannot create an executable payout", async () => {
  for (const change of [
    (path: string, b: any) => {
      if (path.includes("/quote/"))
        b.quoteRequest.appFees = [{ recipient: "integrator.near", fee: 4 }];
    },
    (path: string, b: any) => {
      if (path.includes("/account/history/"))
        b.items[0].quoteTransactions[0].txHash = "0x" + "00".repeat(32);
    },
  ])
    await assert.rejects(fixture(change).gateway.prepare(await input()));
});
test("only exact locally approved signed payload submits; exact retry is idempotent", async () => {
  const f = fixture();
  const plan = await f.gateway.prepare(await input());
  const signedData = {
    ...plan.intent,
    signature: await signature(plan.intent.payload),
  };
  const req = {
    operationId: plan.quote.operationId,
    revision: 1,
    leg: "hold" as const,
    quoteId: plan.quote.quoteId,
    signedData,
  };
  assert.equal((await f.gateway.submit(req)).status, "submitted");
  assert.equal((await f.gateway.submit(req)).status, "submitted");
  assert.equal(f.calls.filter((p) => p.includes("/submit-intent/")).length, 1);
  const changed = JSON.parse(plan.intent.payload);
  changed.intents[0].tokens[privateId] = "1";
  const payload = JSON.stringify(changed);
  await assert.rejects(
    f.gateway.submit({
      ...req,
      signedData: {
        ...signedData,
        payload,
        signature: await signature(payload),
      },
    }),
  );
});
test("another child operation cannot reuse one funded operation role", async () => {
  const f = fixture();
  const original = await input();
  await f.gateway.prepare(original);
  await assert.rejects(
    f.gateway.prepare({ ...original, operationId: "other_child" }),
  );
});
test("unknown submission locks prepared role and can only retry exact saved signed bytes", async () => {
  let failed = true;
  const f = fixture((path) => {
    if (path.includes("/submit-intent/") && failed)
      throw new Error("simulated transport failure");
  });
  const plan = await f.gateway.prepare(await input());
  const req = {
    operationId: "source_1",
    revision: 1,
    leg: "hold" as const,
    quoteId: plan.quote.quoteId,
    signedData: {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    },
  };
  assert.equal((await f.gateway.submit(req)).status, "submissionUnknown");
  await assert.rejects(
    f.gateway.prepare(await input()),
    /EARN_PAYOUT_ALREADY_AUTHORIZED/,
  );
  failed = false;
  assert.equal((await f.gateway.submit(req)).status, "submitted");
  assert.equal(
    f.calls.filter((p) => p.includes("/generate-intent/")).length,
    1,
  );
  assert.equal(f.calls.filter((p) => p.includes("/submit-intent/")).length, 2);
});
test("duplicate JSON keys, duplicate provider nonce and changed settled credit fail closed", async () => {
  const duplicate = fixture((path, b) => {
    if (path.includes("/generate-intent/"))
      b.intent.payload = b.intent.payload.replace(
        '"signer_id":',
        '"verifying_contract":"intents.far","signer_id":',
      );
  });
  await assert.rejects(duplicate.gateway.prepare(await input()));
  const repeated = fixture((path, b) => {
    if (path.includes("/generate-intent/")) {
      const m = JSON.parse(b.intent.payload);
      m.nonce = Buffer.alloc(32, 1).toString("base64");
      b.intent.payload = JSON.stringify(m);
    }
  });
  await repeated.gateway.prepare(await input());
  await assert.rejects(repeated.gateway.prepare(await input("invest")));
  let changed = false;
  const altered = fixture((path, b) => {
    if (changed && path.includes("/account/history/"))
      b.items[0].amountOutFormatted = "0.999";
  });
  await altered.gateway.prepare(await input());
  changed = true;
  await assert.rejects(altered.gateway.prepare(await input("invest")));
});
import { encodeEventTopics } from "viem";
import { erc20Abi } from "viem";
const actualIntentHash = base58.encode(Buffer.alloc(32, 7));
function deliveredFixture(
  change?: (path: string, body: any, init?: RequestInit) => void,
  profileChainId: 1 | 4663 = 1,
) {
  return fixture((path, b, init) => {
    if (
      path.includes("/account/history/") &&
      new URL(path).searchParams.get("depositAddress") === "payout-1.near"
    )
      b.items = [
        {
          status: "SUCCESS",
          depositType: "CONFIDENTIAL_INTENTS",
          recipientType: "DESTINATION_CHAIN",
          refundType: "CONFIDENTIAL_INTENTS",
          createdAt: new Date(now).toISOString(),
          depositAddress: "payout-1.near",
          originAsset: monadUsdcAssetId,
          destinationAsset:
            profileChainId === 4663
              ? robinhoodUsdgAssetId
              : ethereumUsdcAssetId,
          recipient: hold,
          refundTo: C,
          amountInFormatted: "0.0995",
          amountOutFormatted: "0.0995",
          quoteTransactions: [{ sender: C, txHash: actualIntentHash }],
        },
      ];
    if (path === "https://ethereum.test/") {
      const req = JSON.parse(String(init?.body));
      if (req.method === "eth_getTransactionReceipt")
        b.result = {
          transactionHash: "0x" + "aa".repeat(32),
          blockHash: "0x" + "bb".repeat(32),
          blockNumber: "0x65",
          status: "0x1",
          transactionIndex: "0x0",
          gasUsed: "0x1",
          cumulativeGasUsed: "0x1",
          effectiveGasPrice: "0x1",
          from: sourceOwner,
          to: hold,
          type: "0x2",
          logs: [
            {
              address:
                profileChainId === 4663
                  ? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
                  : "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
              data: toHex(99500n, { size: 32 }),
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: {
                  from: sourceOwner as `0x${string}`,
                  to: hold as `0x${string}`,
                },
              }),
              transactionHash: "0x" + "aa".repeat(32),
              blockHash: "0x" + "bb".repeat(32),
              blockNumber: "0x65",
              logIndex: "0x0",
              transactionIndex: "0x0",
              removed: false,
            },
          ],
        };
      if (
        req.method === "eth_getBlockByNumber" &&
        req.params[0] !== "latest" &&
        req.params[0] !== "0x64"
      )
        b.result = {
          ...b.result,
          number: "0x65",
          hash: "0x" + "bb".repeat(32),
          timestamp: toHex(BigInt(now / 1000)),
        };
    }
    change?.(path, b, init);
  }, profileChainId);
}
async function submitPlan(f: ReturnType<typeof fixture>) {
  const p = await f.gateway.prepare(await input());
  await f.gateway.submit({
    operationId: "source_1",
    revision: 1,
    leg: "hold",
    quoteId: p.quote.quoteId,
    signedData: { ...p.intent, signature: await signature(p.intent.payload) },
  });
  return {
    operationId: "source_1",
    revision: 1,
    leg: "hold" as const,
    quoteId: p.quote.quoteId,
    signedData: await readAuth(),
    destinationTransactionHash: "0x" + "aa".repeat(32),
  };
}
test("payout delivery requires matching authenticated outgoing history and exact finalized canonical Transfer", async () => {
  const f = deliveredFixture();
  const req = await submitPlan(f);
  const historyOnly = await f.gateway.reconcile({
    ...req,
    destinationTransactionHash: undefined,
  });
  assert.equal(historyOnly.status, "awaitingDestinationConfirmation");
  assert.equal(historyOnly.receivedAtoms, "0");
  const result = await f.gateway.reconcile(req);
  assert.equal(result.status, "delivered");
  assert.equal(result.receivedAtoms, "99500");
  assert.equal(
    result.destinationTransactionHash,
    req.destinationTransactionHash,
  );
  assert.equal(JSON.stringify(result).includes("private-jwt"), false);
});

test("balance-attested payouts prepare both legs and reconcile after restart without history access", async () => {
  const f = deliveredFixture((path, body) => {
    if (path.includes("/account/history/"))
      throw Error("History is invite-only for now");
    if (path.includes("/status/")) body.status = "SUCCESS";
  });
  const request = await input();
  const expected = {
    ...request.source,
    baselineEnvelope: "saved-baseline",
    quoteEnvelope: "saved-quote",
    maximumCreditAtoms: "995001",
  };
  const { quoteId: _quote, revision: _revision, ...binding } = expected;
  const canonical = Object.fromEntries(
    Object.entries(binding)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v.startsWith("0x") ? v.toLowerCase() : v]),
  );
  const settlementEnvelope = new EarnRecoveryEnvelope("11".repeat(32)).seal(
    "source-credit",
    {
      binding: canonical,
      proof: { status: "credited", creditedAtoms: "995001" },
    },
  );
  const newSource = { ...expected, settlementEnvelope };
  const plan = await f.gateway.prepare({ ...request, source: newSource });
  await f.gateway.prepare({ ...(await input("invest")), source: newSource });
  const submittedIntent = {
    ...plan.intent,
    signature: await signature(plan.intent.payload),
  };
  await f.gateway.submit({
    operationId: request.operationId,
    revision: 1,
    leg: "hold",
    quoteId: plan.quote.quoteId,
    signedData: submittedIntent,
  });
  const req = {
    operationId: request.operationId,
    revision: 1,
    leg: "hold" as const,
    quoteId: plan.quote.quoteId,
    signedData: await readAuth(),
    submittedIntent,
    recoveryEnvelope: plan.recoveryEnvelope,
  };
  const restarted = f.restart();
  const pending = await restarted.reconcile(req);
  assert.equal(pending.status, "awaitingDestinationConfirmation");
  const result = await restarted.reconcile({
    ...req,
    destinationTransactionHash: "0x" + "aa".repeat(32),
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.receivedAtoms, "99500");
  await assert.rejects(
    restarted.reconcile({
      ...req,
      submittedIntent: {
        ...submittedIntent,
        payload: submittedIntent.payload + " ",
      },
      destinationTransactionHash: "0x" + "aa".repeat(32),
    }),
  );
  assert.equal(
    f.calls.some((path) => path.includes("/account/history/")),
    false,
  );
});

test("history-free payouts reject failed routes, wrong transfers, excess values, duplicate logs and unfinalized/reorganized receipts", async () => {
  const changes: Array<(path: string, b: any, init?: RequestInit) => void> = [
    (path, b) => {
      if (path.includes("/status/")) b.status = "FAILED";
    },
    (path, b, init) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.logs[0].address = invest;
    },
    (path, b, init) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.logs[0].topics[2] = "0x" + "00".repeat(32);
    },
    (path, b, init) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.logs[0].data = toHex(99501n, { size: 32 });
    },
    (path, b, init) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.logs.push({ ...b.result.logs[0], logIndex: "0x1" });
    },
    (path, b, init) => {
      if (path === "https://ethereum.test/") {
        const req = JSON.parse(String(init?.body));
        if (
          req.method === "eth_getBlockByNumber" &&
          req.params[0] === "finalized"
        )
          b.result.number = "0x64";
      }
    },
    (path, b, init) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.blockHash = "0x" + "cc".repeat(32);
    },
  ];
  for (const change of changes) {
    const f = deliveredFixture((path, b, init) => {
      if (path.includes("/account/history/"))
        throw Error("History unavailable");
      change(path, b, init);
    });
    const request = await input(),
      plan = await f.gateway.prepare({
        ...request,
        source: balanceAttestedSource(request.source),
      });
    const submittedIntent = {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    };
    await assert.rejects(
      f.restart().reconcile({
        operationId: request.operationId,
        revision: 1,
        leg: "hold",
        quoteId: plan.quote.quoteId,
        recoveryEnvelope: plan.recoveryEnvelope,
        signedData: await readAuth(),
        submittedIntent,
        destinationTransactionHash: "0x" + "aa".repeat(32),
      }),
    );
  }
  const pending = deliveredFixture((path, b) => {
    if (path.includes("/status/")) b.status = "PROCESSING";
  });
  const request = await input(),
    plan = await pending.gateway.prepare({
      ...request,
      source: balanceAttestedSource(request.source),
    });
  const result = await pending.restart().reconcile({
    operationId: request.operationId,
    revision: 1,
    leg: "hold",
    quoteId: plan.quote.quoteId,
    recoveryEnvelope: plan.recoveryEnvelope,
    signedData: await readAuth(),
    submittedIntent: {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    },
  });
  assert.equal(result.status, "awaitingSettlement");
  assert.equal(result.receivedAtoms, "0");
});
test("altered outgoing credit, recipient, private hash or noncanonical public transfer never prove delivery", async () => {
  for (const change of [
    (path: string, b: any) => {
      if (path.includes("depositAddress=payout-1.near"))
        b.items[0].amountOutFormatted = "0.1";
    },
    (path: string, b: any) => {
      if (path.includes("depositAddress=payout-1.near"))
        b.items[0].recipient = invest;
    },
    (path: string, b: any) => {
      if (path.includes("depositAddress=payout-1.near"))
        b.items[0].quoteTransactions[0].txHash = base58.encode(
          Buffer.alloc(32, 6),
        );
    },
    (path: string, b: any, init?: RequestInit) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.blockHash = "0x" + "cc".repeat(32);
    },
    (path: string, b: any, init?: RequestInit) => {
      if (
        path === "https://ethereum.test/" &&
        JSON.parse(String(init?.body)).method === "eth_getTransactionReceipt"
      )
        b.result.logs[0].data = toHex(99501n, { size: 32 });
    },
  ]) {
    const f = deliveredFixture(change);
    await assert.rejects(f.gateway.reconcile(await submitPlan(f)));
  }
});
test("Robinhood payout uses USDG, and EOA0 may hold on another chain after funding on Monad", async () => {
  const hood = fixture(undefined, 4663);
  for (const leg of ["hold", "invest"] as const) {
    const plan = await hood.gateway.prepare(await input(leg, 4663));
    assert.equal(plan.quote.destinationChainId, 4663);
    assert.equal(
      plan.quote.destinationToken.toLowerCase(),
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    );
    assert.equal(plan.quote.applicationFeeAtoms, "0");
    assert.equal(plan.quote.swapType, "EXACT_INPUT");
  }
  const sameEOA = fixture((path, b) => {
    if (path.includes("/account/history/")) {
      b.items[0].refundTo = hold;
      b.items[0].quoteTransactions[0].sender = hold;
    }
  });
  const request = await input();
  request.source.sourceOwner = hold;
  assert.equal(
    (
      await sameEOA.gateway.prepare(request)
    ).quote.destinationRecipient.toLowerCase(),
    hold,
  );
});

test("portable encrypted envelope restores exact signed retry after gateway restart and rejects tuple/ciphertext tampering", async () => {
  const f = fixture();
  const plan = await f.gateway.prepare(await input());
  assert.match(plan.recoveryEnvelope, /^v1\./);
  assert.equal(plan.recoveryEnvelope.includes(C), false);
  assert.equal(plan.recoveryEnvelope.includes("server-key"), false);
  const clear = new EarnRecoveryEnvelope("11".repeat(32)).open(
    "private-payout",
    plan.recoveryEnvelope,
  ) as any;
  assert.equal(clear.request.signedData, undefined);
  assert.equal(clear.prepared.intent.signature, undefined);
  assert.equal(JSON.stringify(clear).includes("private-jwt"), false);
  assert.equal(JSON.stringify(clear).includes("server-key"), false);
  assert.throws(() =>
    new EarnRecoveryEnvelope("22".repeat(32)).open(
      "private-payout",
      plan.recoveryEnvelope,
    ),
  );
  const request = {
    operationId: "source_1",
    revision: 1,
    leg: "hold" as const,
    quoteId: plan.quote.quoteId,
    recoveryEnvelope: plan.recoveryEnvelope,
    signedData: {
      ...plan.intent,
      signature: await signature(plan.intent.payload),
    },
  };
  const restarted = f.restart();
  assert.equal((await restarted.submit(request)).status, "submitted");
  assert.equal((await restarted.submit(request)).status, "submitted");
  assert.equal(f.calls.filter((p) => p.includes("/submit-intent/")).length, 1);
  await assert.rejects(f.restart().submit({ ...request, leg: "invest" }));
  await assert.rejects(
    f.restart().submit({
      ...request,
      recoveryEnvelope: request.recoveryEnvelope.slice(0, -8) + "AAAAAAAA",
    }),
  );
  const payload = plan.intent.payload.replace('"99500"', '"99501"');
  await assert.rejects(
    f.restart().submit({
      ...request,
      signedData: {
        ...plan.intent,
        payload,
        signature: await signature(payload),
      },
    }),
  );
});
test("fresh source proof keeps unexpired payload nonce; expired unsigned re-quote is explicit and signed children cannot change nonce", async () => {
  const f = fixture();
  const request = await input();
  const first = await f.gateway.prepare(request);
  f.advance(61000);
  const refreshed = await f.gateway.prepare({
    ...request,
    signedData: await readAuth(f.clock()),
    recoveryEnvelope: first.recoveryEnvelope,
  });
  assert.equal(refreshed.intent.payload, first.intent.payload);
  assert.equal(refreshed.quote.quoteId, first.quote.quoteId);
  assert.equal(refreshed.sourceCredit.observedAtMs, f.clock());
  f.advance(540000);
  await assert.rejects(
    f.gateway.prepare({
      ...request,
      signedData: await readAuth(f.clock()),
      recoveryEnvelope: refreshed.recoveryEnvelope,
    }),
  );
  const replacement = await f.gateway.prepare({
    ...request,
    signedData: await readAuth(f.clock()),
    recoveryEnvelope: refreshed.recoveryEnvelope,
    replaceExpiredUnsigned: true,
  });
  assert.notEqual(replacement.quote.quoteId, first.quote.quoteId);
  assert.notEqual(
    JSON.parse(replacement.intent.payload).nonce,
    JSON.parse(first.intent.payload).nonce,
  );
  await f.gateway.submit({
    operationId: "source_1",
    revision: 1,
    leg: "hold",
    quoteId: replacement.quote.quoteId,
    recoveryEnvelope: replacement.recoveryEnvelope,
    signedData: {
      ...replacement.intent,
      signature: await signature(replacement.intent.payload),
    },
  });
  f.advance(601000);
  await assert.rejects(
    f.gateway.prepare({
      ...request,
      signedData: await readAuth(f.clock()),
      recoveryEnvelope: replacement.recoveryEnvelope,
      replaceExpiredUnsigned: true,
    }),
    /EARN_PAYOUT_ALREADY_AUTHORIZED/,
  );
});
test("reconcile after server restart requires fresh recovered C read authentication and exact outgoing history", async () => {
  const f = deliveredFixture();
  const plan = await f.gateway.prepare(await input());
  const request = {
    operationId: "source_1",
    revision: 1,
    leg: "hold" as const,
    quoteId: plan.quote.quoteId,
    recoveryEnvelope: plan.recoveryEnvelope,
    signedData: await readAuth(),
    destinationTransactionHash: "0x" + "aa".repeat(32),
  };
  const result = await f.restart().reconcile(request);
  assert.equal(result.status, "delivered");
  assert.equal(result.receivedAtoms, "99500");
  assert.equal(JSON.stringify(result).includes("private-jwt"), false);
  await assert.rejects(
    f.restart().reconcile({
      ...request,
      signedData: {
        ...request.signedData,
        signature: await signature(plan.intent.payload),
      },
    }),
  );
});
test("expired signed payout context still reconciles after days and a cold server restart", async () => {
  const f = deliveredFixture();
  const plan = await f.gateway.prepare(await input());
  f.advance(3 * 86400000);
  const result = await f.restart().reconcile({
    operationId: "source_1",
    revision: 1,
    leg: "hold",
    quoteId: plan.quote.quoteId,
    recoveryEnvelope: plan.recoveryEnvelope,
    signedData: await readAuth(f.clock()),
    destinationTransactionHash: "0x" + "aa".repeat(32),
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.receivedAtoms, "99500");
  assert.ok(plan.quote.expiresAtMs < f.clock());
  assert.equal(
    f.calls.filter((url) => url.includes("/submit-intent/")).length,
    0,
  );
});
test("new executable payout preparation fails closed without a stable configured recovery key", async () => {
  const f = fixture(undefined, 1, null);
  await assert.rejects(
    f.gateway.prepare(await input()),
    /EARN_PAYOUT_RECOVERY_UNCONFIGURED/,
  );
  assert.equal(f.calls.length, 0);
});

test("encrypted recovery envelope has randomized authenticated nonces and rejects every changed part", () => {
  const key = new EarnRecoveryEnvelope("11".repeat(32));
  const privateBody = { payload: "private exact payout bytes", role: "hold" };
  const a = key.seal("private-payout", privateBody),
    b = key.seal("private-payout", privateBody);
  assert.notEqual(a, b);
  assert.deepEqual(key.open("private-payout", a), privateBody);
  assert.equal(a.includes(privateBody.payload), false);
  for (const index of [1, 2, 3]) {
    const parts = a.split(".");
    parts[index] =
      (parts[index]![0] === "A" ? "B" : "A") + parts[index]!.slice(1);
    assert.throws(() => key.open("private-payout", parts.join(".")));
  }
  assert.throws(() =>
    new EarnRecoveryEnvelope().seal("private-payout", privateBody),
  );
});
test("new unsigned three-day generator default is narrowed before hashing and recovery, with every other field and nonce preserved", async () => {
  let original: any;
  const f = fixture((path, body) => {
    if (path.includes("/generate-intent/")) {
      original = JSON.parse(body.intent.payload);
      original.deadline = new Date(now + 259796000).toISOString();
      body.intent.payload = JSON.stringify(original);
    }
  });
  const prepared = await f.gateway.prepare(await input()),
    bounded = JSON.parse(prepared.intent.payload);
  assert.equal(Date.parse(bounded.deadline), prepared.quote.deadlineMs);
  assert.ok(prepared.quote.deadlineMs <= now + 600000);
  assert.deepEqual({ ...bounded, deadline: original.deadline }, original);
  assert.equal(
    prepared.quote.payloadHash,
    keccak256(toHex(prepared.intent.payload)),
  );
  assert.equal(
    (await f.gateway.prepare(await input())).intent.payload,
    prepared.intent.payload,
  );
  await assert.rejects(
    f.gateway.submit({
      operationId: "source_1",
      revision: 1,
      leg: "hold",
      quoteId: prepared.quote.quoteId,
      signedData: {
        standard: "erc191",
        payload: JSON.stringify(original),
        signature: await signature(JSON.stringify(original)),
      },
    }),
  );
  assert.equal(
    f.calls.some((path) => path.includes("/submit-intent/")),
    false,
  );
});
test("long unsigned defaults do not hide unknown nested effects, duplicate fields or expired original deadlines", async () => {
  for (const change of [
    (payload: string) =>
      payload.replace('"intents":', '"unexpected":true,"intents":'),
    (payload: string) =>
      payload.replace(
        '"intent":"transfer"',
        '"intent":"transfer","extra":true',
      ),
    (payload: string) =>
      payload.replace(
        '"deadline":',
        '"deadline":"2099-01-01T00:00:00.000Z","deadline":',
      ),
    (payload: string) => {
      const m = JSON.parse(payload);
      m.deadline = new Date(now + 10000).toISOString();
      return JSON.stringify(m);
    },
  ]) {
    const f = fixture((path, body) => {
      if (path.includes("/generate-intent/")) {
        const m = JSON.parse(body.intent.payload);
        m.deadline = new Date(now + 259796000).toISOString();
        body.intent.payload = change(JSON.stringify(m));
      }
    });
    await assert.rejects(f.gateway.prepare(await input()));
    assert.equal(
      f.calls.some((path) => path.includes("/submit-intent/")),
      false,
    );
  }
});

test("unsigned deadline helper preserves already-bounded bytes and refuses signed envelopes or unbounded quotes", () => {
  const payload = JSON.stringify(
    {
      signer_id: C,
      verifying_contract: "intents.far",
      nonce: Buffer.alloc(32, 1).toString("base64"),
      deadline: new Date(now + 450000).toISOString(),
      intents: [
        {
          intent: "transfer",
          receiver_id: "private-deposit.near",
          tokens: { [privateId]: "99500" },
        },
      ],
    },
    null,
    2,
  );
  assert.equal(
    boundUnsignedPayoutDeadline(payload, now + 600000, now),
    payload,
  );
  for (const limit of [now + 15000, now + 600001, Number.NaN])
    assert.throws(() => boundUnsignedPayoutDeadline(payload, limit, now));
  assert.throws(() =>
    boundUnsignedPayoutDeadline(
      JSON.stringify({
        standard: "erc191",
        payload,
        signature: "already-signed",
      }),
      now + 600000,
      now,
    ),
  );
});

async function withdrawalInput(
  routeKind: "returnUsdc" | "returnEth" | "hoodTokenReturn" = "returnUsdc",
): Promise<WithdrawalPrepareInput> {
  const original = await input();
  const { leg: _leg, ...request } = original;
  return {
    ...request,
    operationId: "withdrawal_1",
    profileChainId:
      routeKind === "hoodTokenReturn" ? (4663 as const) : (1 as const),
    cycleIndex: 2,
    recipient: hold,
    source: {
      ...request.source,
      operationId: "return_1",
      routeKind,
      originAsset:
        routeKind === "returnEth"
          ? "nep141:eth.omft.near"
          : routeKind === "hoodTokenReturn"
            ? robinhoodUsdgAssetId
            : ethereumUsdcAssetId,
    },
  };
}
function withdrawalFixture(
  change?: (path: string, body: any, init?: RequestInit) => void,
) {
  return fixture((path, body, init) => {
    if (
      path === "https://ethereum.test/" &&
      JSON.parse(String(init?.body)).method === "eth_chainId"
    )
      body.result = "0x8f";
    if (path.includes("/account/history/"))
      body.items[0].originAsset = ethereumUsdcAssetId;
    change?.(path, body, init);
  });
}

test("history-free returned credit supports a fresh Monad withdrawal and finalized delivery after restart", async () => {
  const f = deliveredFixture((path, b, init) => {
    if (path.includes("/account/history/"))
      throw Error("History is invite-only for now");
    if (path === "https://ethereum.test/") {
      const req = JSON.parse(String(init?.body));
      if (req.method === "eth_chainId") b.result = "0x8f";
      if (req.method === "eth_getTransactionReceipt") {
        b.result.logs[0].address = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
        b.result.logs[0].data = toHex(995001n, { size: 32 });
      }
    }
  });
  const request = await withdrawalInput("hoodTokenReturn");
  const {
    quoteId: _quote,
    revision: _revision,
    routeKind: _route,
    ...source
  } = request.source;
  const binding = {
    ...source,
    baselineEnvelope: "baseline",
    quoteEnvelope: "quote",
    maximumCreditAtoms: "995001",
  };
  const canonical = Object.fromEntries(
    Object.entries(binding)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v.startsWith("0x") ? v.toLowerCase() : v]),
  );
  const settlementEnvelope = new EarnRecoveryEnvelope("11".repeat(32)).seal(
    "source-credit",
    {
      binding: canonical,
      proof: { status: "credited", creditedAtoms: "995001" },
    },
  );
  const p = await f.gateway.prepareWithdrawal({
    ...request,
    source: { ...request.source, ...binding, settlementEnvelope },
  });
  const submittedIntent = {
    ...p.intent,
    signature: await signature(p.intent.payload),
  };
  const req = {
    operationId: request.operationId,
    revision: 1,
    leg: "withdrawal" as const,
    quoteId: p.quote.quote.quoteId,
    recoveryEnvelope: p.recoveryEnvelope,
    signedData: await readAuth(),
    submittedIntent,
    destinationTransactionHash: "0x" + "aa".repeat(32),
  };
  const result = await f.restart().reconcileWithdrawal(req);
  assert.equal(result.status, "delivered");
  assert.equal(result.receivedAtoms, "995001");
  assert.equal(result.destinationChainId, 143);
});
test("withdrawal prepares the entire authenticated returned credit to fresh public Monad USDC and binds the return child", async () => {
  const f = withdrawalFixture();
  const prepared = await f.gateway.prepareWithdrawal(await withdrawalInput());
  assert.equal(prepared.sourceCredit.returnOperationId, "return_1");
  assert.equal(prepared.sourceCredit.credit.operationId, "withdrawal_1");
  assert.equal(prepared.sourceCredit.credit.sourceChainId, 1);
  assert.equal(prepared.sourceCredit.credit.sourceAssetId, ethereumUsdcAssetId);
  assert.equal(prepared.sourceCredit.credit.creditedAtoms, "995001");
  assert.equal(prepared.quote.destinationChainId, 143);
  assert.equal(prepared.quote.quote.leg, "withdrawal");
  assert.equal(
    prepared.quote.quote.destinationToken.toLowerCase(),
    "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  );
  assert.equal(prepared.quote.quote.destinationAsset, monadUsdcAssetId);
  assert.equal(prepared.quote.quote.amountAtoms, "995001");
  assert.equal(prepared.quote.quote.sourceAssetId, ethereumUsdcAssetId);
  assert.equal(prepared.quote.quote.feePolicy?.route, "withdrawal");
  assert.equal(prepared.quote.quote.applicationFeeAtoms, "0");
  assert.equal(JSON.stringify(prepared).includes("private-jwt"), false);
  assert.equal(
    (await f.gateway.prepareWithdrawal(await withdrawalInput())).quote.quote
      .quoteId,
    prepared.quote.quote.quoteId,
  );
  const request = {
    operationId: "withdrawal_1",
    revision: 1,
    leg: "withdrawal" as const,
    quoteId: prepared.quote.quote.quoteId,
    recoveryEnvelope: prepared.recoveryEnvelope,
    signedData: {
      ...prepared.intent,
      signature: await signature(prepared.intent.payload),
    },
  };
  assert.equal(
    (await f.restart().submitWithdrawal(request)).status,
    "submitted",
  );
  await assert.rejects(
    f.gateway.submit(request as never),
    /INVALID_PAYOUT_SUBMISSION/,
  );
  await assert.rejects(
    f.gateway.prepare({ ...(await input()), leg: "withdrawal" } as never),
    /INVALID_PAYOUT_REQUEST/,
  );
});
test("withdrawal rejects changed return route, private credit history, cycle binding and arbitrary application fees", async () => {
  const mismatch = await withdrawalInput();
  mismatch.source.originAsset = monadUsdcAssetId as never;
  await assert.rejects(withdrawalFixture().gateway.prepareWithdrawal(mismatch));
  for (const change of [
    (path: string, b: any) => {
      if (path.includes("/account/history/"))
        b.items[0].quoteTransactions[0].txHash = "0x" + "aa".repeat(32);
    },
    (path: string, b: any) => {
      if (path.includes("/account/history/")) b.items = [];
    },
    (path: string, b: any) => {
      if (path.includes("/quote/"))
        b.quoteRequest.appFees = [{ recipient: "gizu.near", fee: 2 }];
    },
    (path: string, b: any) => {
      if (path.includes("/quote/"))
        b.quoteRequest.destinationAsset = ethereumUsdcAssetId;
    },
  ])
    await assert.rejects(
      withdrawalFixture(change).gateway.prepareWithdrawal(
        await withdrawalInput(),
      ),
    );
  const f = withdrawalFixture();
  await f.gateway.prepareWithdrawal(await withdrawalInput());
  await assert.rejects(
    f.gateway.prepareWithdrawal({
      ...(await withdrawalInput()),
      cycleIndex: 3,
    }),
  );
  await assert.rejects(
    f.gateway.prepareWithdrawal({
      ...(await withdrawalInput()),
      operationId: "other_withdrawal",
    }),
  );
});

test("withdrawal preserves each return profile's original token and decimals while consuming only private Monad USDC", async () => {
  for (const routeKind of [
    "returnUsdc",
    "returnEth",
    "hoodTokenReturn",
  ] as const) {
    const request = await withdrawalInput(routeKind);
    if (routeKind === "returnEth")
      request.source.amountAtoms = "1000000000000000000";
    const f = withdrawalFixture((path, b) => {
      if (path.includes("/account/history/"))
        b.items[0].originAsset = request.source.originAsset;
    });
    const p = await f.gateway.prepareWithdrawal(request);
    assert.equal(
      p.sourceCredit.credit.sourceChainId,
      routeKind === "hoodTokenReturn" ? 4663 : 1,
    );
    assert.equal(
      p.sourceCredit.credit.sourceDecimals,
      routeKind === "returnEth" ? 18 : 6,
    );
    assert.equal(
      p.sourceCredit.credit.sourceToken.toLowerCase(),
      routeKind === "returnEth"
        ? "0x" + "00".repeat(20)
        : routeKind === "returnUsdc"
          ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
          : "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    );
    assert.equal(p.quote.quote.privateTokenId, privateId);
    assert.equal(p.quote.quote.destinationAsset, monadUsdcAssetId);
    await assert.rejects(
      f.gateway.prepareWithdrawal({
        ...request,
        profileChainId: routeKind === "hoodTokenReturn" ? 1 : 4663,
      }),
    );
  }
});
test("withdrawal completion requires exact authenticated outgoing history and canonical finalized Monad transfer after restart", async () => {
  const f = deliveredFixture((path, b, init) => {
    if (path === "https://ethereum.test/") {
      const request = JSON.parse(String(init?.body));
      if (request.method === "eth_chainId") b.result = "0x8f";
      if (request.method === "eth_getTransactionReceipt") {
        b.result.logs[0].address = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
        b.result.logs[0].data = toHex(995001n, { size: 32 });
      }
    }
    if (path.includes("/account/history/")) {
      if (
        new URL(path).searchParams.get("depositAddress") === "payout-1.near"
      ) {
        b.items[0].destinationAsset = monadUsdcAssetId;
        b.items[0].amountInFormatted = "0.995001";
        b.items[0].amountOutFormatted = "0.995001";
      } else b.items[0].originAsset = ethereumUsdcAssetId;
    }
  });
  const p = await f.gateway.prepareWithdrawal(await withdrawalInput());
  const request = {
    operationId: "withdrawal_1",
    revision: 1,
    leg: "withdrawal" as const,
    quoteId: p.quote.quote.quoteId,
    recoveryEnvelope: p.recoveryEnvelope,
    signedData: await readAuth(),
    destinationTransactionHash: "0x" + "aa".repeat(32),
  };
  const missingReceipt = await f
    .restart()
    .reconcileWithdrawal({ ...request, destinationTransactionHash: undefined });
  assert.equal(missingReceipt.status, "awaitingDestinationConfirmation");
  assert.equal(missingReceipt.receivedAtoms, "0");
  const delivered = await f.restart().reconcileWithdrawal(request);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.receivedAtoms, "995001");
  assert.equal(delivered.destinationChainId, 143);
});

test("payout split uses native authenticated prior-credit offset so batch rounding remains exactly ten percent", async () => {
  const credit = "100009";
  const first = fixture((path, b) => {
    if (path.includes("/account/history/"))
      b.items[0].amountOutFormatted = "0.100009";
  });
  const second = fixture((path, b) => {
    if (path.includes("/account/history/"))
      b.items[0].amountOutFormatted = "0.100009";
  });
  const a = await input(),
    b = await input();
  a.source.minimumCreditAtoms = "100000";
  b.source.minimumCreditAtoms = "100000";
  const firstHold = await first.gateway.prepare({
    ...a,
    splitOffsetAtoms: "0",
  });
  const secondHold = await second.gateway.prepare({
    ...b,
    splitOffsetAtoms: credit,
  });
  const secondInvest = await second.gateway.prepare({
    ...b,
    leg: "invest",
    recipient: invest,
    splitOffsetAtoms: credit,
  });
  assert.equal(firstHold.quote.amountAtoms, "10000");
  assert.equal(secondHold.quote.amountAtoms, "10001");
  assert.equal(secondInvest.quote.amountAtoms, "90008");
  assert.equal(
    BigInt(firstHold.quote.amountAtoms) + BigInt(secondHold.quote.amountAtoms),
    (2n * BigInt(credit)) / 10n,
  );
  assert.equal(secondHold.sourceCredit.sourceOwner.toLowerCase(), sourceOwner);
  await assert.rejects(second.gateway.prepare({ ...b, splitOffsetAtoms: "0" }));
});

test("payout preparation binds selected native source and cycle through recovery", async () => {
  const f = fixture();
  const request = { ...(await input()), sourceAccountIndex: 7, cycleIndex: 3 };
  const prepared = await f.gateway.prepare(request);
  assert.equal(prepared.sourceCredit.sourceOwner.toLowerCase(), sourceOwner);
  const restored = await f.restart().prepare({
    ...request,
    recoveryEnvelope: prepared.recoveryEnvelope,
  });
  assert.equal(restored.quote.quoteId, prepared.quote.quoteId);
  for (const changed of [
    { sourceAccountIndex: 8, cycleIndex: 3 },
    { sourceAccountIndex: 7, cycleIndex: 4 },
  ]) {
    await assert.rejects(
      f.restart().prepare({
        ...request,
        ...changed,
        recoveryEnvelope: prepared.recoveryEnvelope,
      }),
    );
  }
  await assert.rejects(
    f.gateway.prepare({
      ...request,
      leg: "invest",
      recipient: invest,
      cycleIndex: 4,
    }),
  );
});

test("legacy payout requests default native source and cycle to zero", async () => {
  const f = fixture();
  const legacy = await input();
  const prepared = await f.gateway.prepare(legacy);
  const explicit = await f.gateway.prepare({
    ...legacy,
    sourceAccountIndex: 0,
    cycleIndex: 0,
  });
  assert.equal(explicit.quote.quoteId, prepared.quote.quoteId);
});

test("equal bundled credits cannot be claimed for a second funding owner", async () => {
  const f = fixture();
  const first = await input();
  await f.gateway.prepare({ ...first, sourceAccountIndex: 0 });
  const otherId = "source_bundled_2";
  const other = {
    ...first,
    operationId: otherId,
    sourceAccountIndex: 7,
    source: {
      ...first.source,
      operationId: otherId,
      sourceOwner: "0x" + "ab".repeat(20),
    },
  };
  await assert.rejects(f.gateway.prepare(other), /EARN_PAYOUT_CREDIT_BOUND/);
  // A restarted gateway also rejects this alias from authenticated single-owner history.
  await assert.rejects(
    f.restart().prepare(other),
    /EARN_PRIVATE_PAYOUT_UNAVAILABLE/,
  );
  assert.equal(f.calls.filter((path) => path.includes("/quote/")).length, 1);
});
test("Robinhood 10/90 payout quotes allow 5% slippage; other payouts keep exact quotes", async () => {
  const sent: Record<string, number[]> = { 4663: [], 1: [] };
  for (const chain of [4663, 1] as const) {
    const f = fixture((path, _b, init) => {
      if (path.includes("/quote/"))
        sent[chain]!.push(JSON.parse(String(init?.body)).slippageTolerance);
    }, chain);
    for (const leg of ["hold", "invest"] as const)
      await f.gateway.prepare(await input(leg, chain));
  }
  assert.deepEqual(sent[4663], [500, 500]);
  assert.deepEqual(sent[1], [0, 0]);
});

test("Robinhood payouts are delivered from a canonical receipt before L1 finality, like Swap", async () => {
  for (const chain of [4663, 1] as const) {
    // The finalized head (0x64) is behind the payout receipt block (0x65).
    const f = deliveredFixture((path, b, init) => {
      if (path.includes("/account/history/"))
        throw Error("History unavailable");
      if (path === "https://ethereum.test/") {
        const req = JSON.parse(String(init?.body));
        if (
          req.method === "eth_getBlockByNumber" &&
          req.params[0] === "finalized"
        )
          b.result = {
            ...b.result,
            number: "0x64",
            hash: "0x" + "dd".repeat(32),
          };
      }
    }, chain);
    const request = await input("hold", chain),
      plan = await f.gateway.prepare({
        ...request,
        source: balanceAttestedSource(request.source),
      });
    const settle = f.restart().reconcile({
      operationId: request.operationId,
      revision: 1,
      leg: "hold",
      quoteId: plan.quote.quoteId,
      recoveryEnvelope: plan.recoveryEnvelope,
      signedData: await readAuth(),
      submittedIntent: {
        ...plan.intent,
        signature: await signature(plan.intent.payload),
      },
      destinationTransactionHash: "0x" + "aa".repeat(32),
    });
    if (chain === 4663) {
      const result = await settle;
      assert.equal(result.status, "delivered");
      assert.equal(result.receivedAtoms, "99500");
    } else await assert.rejects(settle);
  }
});

test('shared payout guards survive replica restart, prevent rebinding and never resend uncertain authority',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  const rows=new Map<string,string>();const store={async bind(key:string,value:string,_expires:number,exclusive:boolean){const old=rows.get(key);if(old)return !exclusive&&old===value;rows.set(key,value);return true;}};
  const coordination=new OperationCoordinator(store,'ab'.repeat(32));
  const f=fixture(undefined,1,'11'.repeat(32),coordination);
  const prepared=await f.gateway.prepare(await input());
  const signedData={...prepared.intent,signature:await signature(prepared.intent.payload)};
  const req={operationId:'source_1',revision:1,leg:'hold' as const,quoteId:prepared.quote.quoteId,signedData,recoveryEnvelope:prepared.recoveryEnvelope};
  const results=await Promise.all([f.gateway.submit(req),f.restart().submit(req)]);
  assert.equal(results.filter(r=>r.status==='submitted').length,1);
  assert.equal((await f.restart().submit(req)).status,'submissionUnknown');
  assert.equal(f.calls.filter(p=>p.includes('/submit-intent/')).length,1);
  await assert.rejects(f.restart().prepare({...await input(),operationId:'another_child'}));
  assert.equal(JSON.stringify([...rows]).includes(C),false);
});
async function assertSharedDistributionGuards(coordination: OperationCoordinator, clock = now) {
  const f = fixture(undefined, 1, "11".repeat(32), coordination, clock);
  for (const slot of [0, 1, 2, 3, 4] as const) {
    const request = { ...await distributionInput(slot, [2000, 2000, 2000, 2000, 2000]), signedData: await readAuth(clock) };
    const prepared = await f.restart().prepare(request);
    const submission = {
      operationId: request.operationId,
      revision: request.revision,
      leg: request.leg,
      distribution: request.distribution,
      quoteId: prepared.quote.quoteId,
      recoveryEnvelope: prepared.recoveryEnvelope,
      signedData: { ...prepared.intent, signature: await signature(prepared.intent.payload) },
    };
    const results = await Promise.all([
      f.restart().submit(submission),
      f.restart().submit(submission),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["submissionUnknown", "submitted"]);
    for (const result of results) {
      assert.equal(result.leg, request.leg);
      assert.deepEqual(result.distribution, request.distribution);
    }
    const replay = await f.restart().submit(submission);
    assert.equal(replay.status, "submissionUnknown");
    assert.deepEqual(replay.distribution, request.distribution);
    await assert.rejects(f.restart().prepare({
      ...request,
      recipient: "0x" + "ab".repeat(20),
    }), (error: any) => error.code === "EARN_COORDINATION_CONFLICT");
  }
  assert.equal(f.calls.filter((path) => path.includes("/submit-intent/")).length, 5);
  await assert.rejects(f.restart().prepare({
    ...await distributionInput(0),
    signedData: await readAuth(clock),
    distribution: { version: 1, weightsBps: [5000, 5000] },
  }), (error: any) => error.code === "EARN_COORDINATION_CONFLICT");
}

test("shared distribution guards preserve independent slots and recovered replay protection", async () => {
  const rows = new Map<string, string>();
  const coordination = new OperationCoordinator({
    async bind(key, value, _expires, exclusive) {
      const prior = rows.get(key);
      if (prior) return !exclusive && prior === value;
      rows.set(key, value);
      return true;
    },
  }, "ab".repeat(32));
  await assertSharedDistributionGuards(coordination);
});

test("PostgreSQL distribution guards preserve independent slots and recovered replay protection", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `payout_test_${randomBytes(8).toString("hex")}`;
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`create schema ${schema}`);
    await assertSharedDistributionGuards(new OperationCoordinator(new PgOperationCoordination(pool), "ab".repeat(32)), Math.floor(Date.now() / 1000) * 1000);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});

test('unauthenticated payout preparation cannot occupy durable funding roles',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  const rows=new Map<string,string>();const coordination=new OperationCoordinator({async bind(key,value){rows.set(key,value);return true;}},'ab'.repeat(32));
  const f=fixture(undefined,1,'11'.repeat(32),coordination),r=await input();
  await assert.rejects(f.gateway.prepare({...r,signedData:{...r.signedData,signature:'secp256k1:'+base58.encode(Buffer.alloc(65,1))}}));
  assert.equal(rows.size,0,'only authenticated actual credit may create persistent bindings');
});
test('temporary shared-store outage blocks payout sends and permits an untouched signed record after recovery',async()=>{
  const {OperationCoordinator}=await import('../../../src/adapters/earn/operation-coordinator.ts');
  let down=false;const rows=new Map<string,string>();
  const coordination=new OperationCoordinator({async bind(key,value,_expires,exclusive){if(down)throw new Error('private database detail');const old=rows.get(key);if(old)return !exclusive&&old===value;rows.set(key,value);return true;}},'ab'.repeat(32));
  const f=fixture(undefined,1,'11'.repeat(32),coordination),p=await f.gateway.prepare(await input());
  const req={operationId:p.quote.operationId,revision:1,leg:'hold' as const,quoteId:p.quote.quoteId,signedData:{...p.intent,signature:await signature(p.intent.payload)}};
  down=true;await assert.rejects(f.gateway.submit(req),(error:any)=>error.statusCode===503);
  assert.equal(f.calls.filter(p=>p.includes('/submit-intent/')).length,0);
  down=false;assert.equal((await f.gateway.submit(req)).status,'submitted');
  assert.equal(f.calls.filter(p=>p.includes('/submit-intent/')).length,1);
});

test('expired payout caches reclaim role, credit and nonce bindings while native envelopes remain recoverable',async()=>{
  const f=fixture((path,body)=>{if(path.includes('/generate-intent/')){const message=JSON.parse(body.intent.payload);message.nonce=Buffer.alloc(32,1).toString('base64');body.intent.payload=JSON.stringify(message);}});const original=await input(),first=await f.gateway.prepare(original);
  f.advance(86401000);
  const next=await input();next.signedData=await readAuth(f.clock());
  // The provider repeats its first nonce under a fresh process: expired local
  // nonce and role state must not create a lifetime allocation limit.
  const prepared=await f.gateway.prepare({...next,cycleIndex:1,sourceAccountIndex:1});
  assert.notEqual(prepared.quote.quoteId,first.quote.quoteId);
  await assert.rejects(f.gateway.submit({operationId:first.quote.operationId,revision:1,leg:'hold',quoteId:first.quote.quoteId,signedData:{...first.intent,signature:await signature(first.intent.payload)}}));
});

test('payout admission reclaims all 512 expired operation slots and their credit associations',async()=>{
  let counter=0;let transaction=sourceTx;
  const f=fixture((path,body)=>{
    if(path.includes('/account/history/'))body.items[0].quoteTransactions[0].txHash=transaction;
    if(path.includes('/generate-intent/')){const message=JSON.parse(body.intent.payload),nonce=Buffer.alloc(32);nonce.writeUInt32LE(counter);message.nonce=nonce.toString('base64');body.intent.payload=JSON.stringify(message);}
  });
  const base=await input();
  const next=()=>{transaction='0x'+counter.toString(16).padStart(64,'0');const operationId='capacity_'+counter;return{...base,operationId,source:{...base.source,operationId,transactionHash:transaction}};};
  for(counter=0;counter<512;counter++)await f.gateway.prepare(next(),'capacity-client-'+Math.floor(counter/20));
  await assert.rejects(f.gateway.prepare(next(),'capacity-extra'),(error:any)=>error.code==='EARN_PAYOUT_CAPACITY');
  f.advance(86401000);base.signedData=await readAuth(f.clock());
  const reclaimed=await f.gateway.prepare(next(),'capacity-extra');assert.equal(reclaimed.quote.operationId,'capacity_512');
});
