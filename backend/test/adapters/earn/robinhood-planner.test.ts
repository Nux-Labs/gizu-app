import assert from "node:assert/strict";
import test from "node:test";
import { RobinhoodDepositPlanner } from "../../../src/adapters/earn/robinhood-deposit-planner.ts";
import { ROBINHOOD_PROFILE } from "../../../src/adapters/earn/robinhood-vault.ts";
import { mergeRobinhoodTraces } from "../../../src/adapters/earn/robinhood-simulation.ts";
const owner = "0x1000000000000000000000000000000000000001" as const;
const state = {
  owner,
  block: {
    number: 10n,
    hash: "0x" + "a".repeat(64),
    timestamp: 1000n,
    baseFeePerGas: 1n,
    gasUsed: 1n,
    gasLimit: 2n,
  },
  token: 1000000n,
  shares: 0n,
  native: 0n,
  wrappedNative: 0n,
  nonce: 0n,
  ownerCode: "0x",
  shareDecimals: 18,
};
const simulation = {
  shares: 100n,
  previewShares: 100n,
  maxSharePrice: 1n,
  depositCalls: [
    { to: ROBINHOOD_PROFILE.router, data: "0x12" as const, value: 0n },
  ],
  withdrawalCalls: [
    { to: ROBINHOOD_PROFILE.router, data: "0x34" as const, value: 0n },
  ],
  stateOverride: [],
  deposit: [
    {
      to: ROBINHOOD_PROFILE.router,
      data: "0x12",
      estimatedGas: 100n,
      actualGas: 90n,
    },
  ],
  withdrawal: [
    {
      to: ROBINHOOD_PROFILE.router,
      data: "0x34",
      estimatedGas: 100n,
      actualGas: 90n,
    },
  ],
};
const deps = {
  readState: async () => state,
  market: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
  simulate: async () => simulation,
  prepare: async () => ({
    operation: {
      sender: owner,
      callData: "0x" as const,
      callGasLimit: "0x1" as const,
      maxFeePerGas: "0x6e" as const,
      maxPriorityFeePerGas: "0xb" as const,
      nonce: "0x0" as const,
      preVerificationGas: "0x1" as const,
      verificationGasLimit: "0x1" as const,
      signature: "0x" as const,
    },
    feeCap: 100n,
    fees: { maxFeePerGas: 110n, maxPriorityFeePerGas: 11n },
    delegation: owner,
    authorizationRequired: true,
    authorizationNonce: 0,
  }),
  assertFresh: async () => {},
};
test("half-balance probe grows to exact deposit after five-percent fee and 2.6x withdrawal reserve", async () => {
  const p = new RobinhoodDepositPlanner(
    { rpcUrl: "http://rpc.invalid" },
    deps,
    () => 1000000,
  );
  const plan = await p.plan({ owner, revision: 1, operationId: "cycle" });
  assert.equal(plan.depositAmount, "999635");
  assert.equal(plan.depositFeeBudget, "105");
  assert.equal(plan.withdrawalReserve, "260");
  assert.equal(plan.retainedLiquidUsdg, "365");
  assert.equal(plan.simulation.withdrawalPurpose, "reserve-only-isolated-fork");
  assert.equal(plan.executionAvailable, false);
  assert.ok(Object.isFrozen(plan));
});
test("USDG empty destination, existing shares and native/wrapped balances reject", async () => {
  for (const change of [
    { token: 0n },
    { shares: 1n },
    { native: 1n },
    { wrappedNative: 1n },
  ]) {
    const p = new RobinhoodDepositPlanner(
      { rpcUrl: "http://rpc.invalid" },
      { ...deps, readState: async () => ({ ...state, ...change }) },
      () => 1000000,
    );
    await assert.rejects(p.plan({ owner, revision: 1, operationId: "cycle" }));
  }
});
test("post-state trace merges exact changed slots and clears deleted slots without fabricating balance/code", () => {
  const slot = "0x" + "1".repeat(64),
    value = "0x" + "2".repeat(64),
    zero = "0x" + "0".repeat(64);
  const result = mergeRobinhoodTraces([
    {
      pre: { [owner]: { balance: "0x999", storage: { [slot]: value } } },
      post: { [owner]: { code: "0x12", storage: {} } },
    },
  ]);
  assert.deepEqual(result, [
    { address: owner, stateDiff: [{ slot, value: zero }] },
  ]);
  assert.throws(() =>
    mergeRobinhoodTraces([
      { pre: { [owner]: { storage: { bad: value } } }, post: {} },
    ]),
  );
});
test("alternating fee caps converge using the largest observed caps and conservative reserves", async () => {
  let preparations = 0;
  const changing = {
    ...deps,
    prepare: async () => {
      const result = await deps.prepare();
      const group = Math.floor(preparations++ / 2);
      return { ...result, feeCap: group % 2 === 0 ? 100n : 200n };
    },
  };
  const p = new RobinhoodDepositPlanner(
    { rpcUrl: "http://rpc.invalid" },
    changing,
    () => 1000000,
  );
  const result = await p.plan({ owner, revision: 1, operationId: "cycle" });
  assert.equal(result.depositQuoteCap, "200");
  assert.equal(result.withdrawalQuoteCap, "200");
  assert.equal(result.depositFeeBudget, "210");
  assert.equal(result.withdrawalReserve, "520");
  assert.equal(result.depositAmount, "999270");
  assert.equal(preparations, 7);
});
test("unbounded fee increases and simulation failures still fail closed", async () => {
  let increasing = 100n;
  const growing = new RobinhoodDepositPlanner(
    { rpcUrl: "http://rpc.invalid" },
    {
      ...deps,
      prepare: async () => ({
        ...(await deps.prepare()),
        feeCap: increasing++,
      }),
    },
    () => 1000000,
  );
  await assert.rejects(
    growing.plan({ owner, revision: 1, operationId: "cycle" }),
    {
      code: "EARN_ROBINHOOD_PLAN_UNAVAILABLE",
    },
  );
  const failed = new RobinhoodDepositPlanner(
    { rpcUrl: "https://server-key.invalid" },
    {
      ...deps,
      simulate: async () => {
        throw new Error("server-key.invalid");
      },
    },
    () => 1000000,
  );
  await assert.rejects(
    failed.plan({ owner, revision: 1, operationId: "cycle" }),
    (e: unknown) =>
      e instanceof Error &&
      !e.message.includes("server-key") &&
      "code" in e &&
      e.code === "EARN_ROBINHOOD_PLAN_UNAVAILABLE",
  );
});
test("funded planning retains the failing stage without retaining provider details in diagnostics", async () => {
  for (const [method, stage] of [
    ["readState", "read-state"],
    ["market", "fee-market"],
    ["simulate", "vault-simulation"],
    ["prepare", "deposit-sponsorship"],
    ["assertFresh", "freshness"],
  ] as const) {
    const p = new RobinhoodDepositPlanner(
      { rpcUrl: "https://sensitive-key.invalid" },
      {
        ...deps,
        [method]: async () => {
          throw Object.assign(new Error("sensitive-account-and-key"), {
            name: "HttpRequestError",
            status: 429,
            code: "sensitive-provider-code",
          });
        },
      },
      () => 1000000,
    );
    await assert.rejects(
      p.plan({ owner, revision: 1, operationId: "cycle" }),
      (e: any) => {
        assert.equal(e.code, "EARN_ROBINHOOD_PLAN_UNAVAILABLE");
        assert.equal(e.diagnostic.stage, stage);
        assert.equal(e.diagnostic.httpStatus, 429);
        assert.equal(
          JSON.stringify(e.diagnostic).includes("sensitive-"),
          false,
        );
        return true;
      },
    );
  }
});

test("withdrawal sponsorship failure is distinct from deposit sponsorship", async () => {
  const p = new RobinhoodDepositPlanner(
    { rpcUrl: "https://offline.invalid" },
    {
      ...deps,
      prepare: async (calls) => {
        if (calls === simulation.withdrawalCalls)
          throw Object.assign(new Error("sensitive-provider-body"), {
            code: -32500,
          });
        return deps.prepare();
      },
    },
    () => 1000000,
  );
  await assert.rejects(
    p.plan({ owner, revision: 1, operationId: "cycle" }),
    (e: any) => {
      assert.equal(e.diagnostic.stage, "withdrawal-sponsorship");
      assert.equal(e.diagnostic.rpcCode, -32500);
      assert.equal(JSON.stringify(e.diagnostic).includes("sensitive-"), false);
      return true;
    },
  );
});
test("final fee drift inside the approved headroom retains the conservative reserve basis", async () => {
  let preparations = 0;
  const p = new RobinhoodDepositPlanner(
    { rpcUrl: "http://rpc.invalid" },
    {
      ...deps,
      prepare: async () => ({
        ...(await deps.prepare()),
        feeCap: ++preparations === 5 ? 101n : 100n,
      }),
    },
    () => 1000000,
  );
  const result = await p.plan({ owner, revision: 1, operationId: "cycle" });
  assert.equal(result.depositQuoteCap, "100");
  assert.equal(result.depositFeeBudget, "105");
  assert.equal(result.depositAmount, "999635");
});
test("unsigned USDG proposal removes SDK signature and authorization placeholders", async () => {
  const result = await new RobinhoodDepositPlanner(
    { rpcUrl: "http://rpc.invalid" },
    deps,
    () => 1000000,
  ).plan({ owner, revision: 1, operationId: "cycle" });
  assert.equal("signature" in result.operation, false);
  assert.equal("authorization" in result.operation, false);
  assert.equal(result.paymasterDataStatus, "stub");
  assert.equal(
    BigInt(result.depositAmount) +
      BigInt(result.depositFeeBudget) +
      BigInt(result.withdrawalReserve),
    state.token,
  );
});
