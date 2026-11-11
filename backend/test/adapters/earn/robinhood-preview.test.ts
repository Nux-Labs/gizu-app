import assert from "node:assert/strict";
import test from "node:test";
import { RobinhoodDepositPreviewPlanner } from "../../../src/adapters/earn/robinhood-deposit-preview.ts";
import { RobinhoodDepositPlanner } from "../../../src/adapters/earn/robinhood-deposit-planner.ts";
import { deps, owner, state } from "./robinhood-preview-fixture.ts";

const request = {
  owner,
  expectedUsdgAtoms: "1000000",
  operationId: "preview_1",
  revision: 1,
};
test("independent deposit and redemption fee estimates overlap without changing reserve math", async () => {
  const events: string[] = [];
  const providers = {
    ...deps,
    readState: async () => ({ ...state, token: 0n }),
    prepare: async () => {
      events.push("started");
      await Promise.resolve();
      events.push("finished");
      return deps.prepare();
    },
  };
  const result = await new RobinhoodDepositPreviewPlanner(
    { rpcUrl: "http://rpc.invalid" },
    providers,
    () => 1000000,
  ).preview(request);
  assert.deepEqual(events.slice(0, 2), ["started", "started"]);
  assert.equal(result.depositAmount, "999635");
  assert.equal(result.depositFeeBudget, "105");
  assert.equal(result.withdrawalReserve, "260");
  assert.equal(events.filter((v) => v === "started").length, 5);
});
test("an unfunded prospective preview retains reserve math but exposes no executable operation", async () => {
  const providers = {
    ...deps,
    readState: async () => ({ ...state, token: 0n }),
  };
  const planner = new RobinhoodDepositPreviewPlanner(
    { rpcUrl: "http://rpc.invalid" },
    providers,
    () => 1000000,
  );
  const result = await planner.preview(request);
  assert.equal(result.kind, "preview");
  assert.equal(result.readOnly, true);
  assert.equal(result.executionAvailable, false);
  assert.equal(result.depositAmount, "999635");
  assert.equal(result.depositFeeBudget, "105");
  assert.equal(result.withdrawalReserve, "260");
  assert.equal("operation" in result, false);
  assert.equal("calldata" in result, false);
  assert.equal(result.assumption, "hypothetical-USDG-funding-isolated-fork");
  await assert.rejects(
    new RobinhoodDepositPlanner(
      { rpcUrl: "http://rpc.invalid" },
      providers,
      () => 1000000,
    ).plan({ owner, operationId: "real", revision: 1 }),
  );
});
test("prospective planning rejects stale data, existing shares, invalid budget and exhausted gas economics", async () => {
  for (const change of [
    { shares: 1n },
    { block: { ...state.block, timestamp: 900n } },
  ]) {
    const planner = new RobinhoodDepositPreviewPlanner(
      { rpcUrl: "http://rpc.invalid" },
      { ...deps, readState: async () => ({ ...state, token: 0n, ...change }) },
      () => 1000000,
    );
    await assert.rejects(planner.preview(request));
  }
  const planner = new RobinhoodDepositPreviewPlanner(
    { rpcUrl: "http://rpc.invalid" },
    { ...deps, readState: async () => ({ ...state, token: 0n }) },
    () => 1000000,
  );
  for (const amount of ["0", "-1", "01", "1", "100", (1n << 256n).toString()])
    await assert.rejects(
      planner.preview({ ...request, expectedUsdgAtoms: amount }),
    );
});
test("remaining previews exclude extra existing USDG from their hypothetical budget", async () => {
  const planner = new RobinhoodDepositPreviewPlanner(
    { rpcUrl: "http://rpc.invalid" },
    { ...deps, readState: async () => ({ ...state, token: 400000n }) },
    () => 1000000,
  );
  const result = await planner.preview({
    ...request,
    startingUsdgAtoms: "400000",
  });
  assert.equal(result.startingUsdgAtoms, "400000");
  assert.equal(result.executionAvailable, false);
  const partial = await planner.preview({
    ...request,
    startingUsdgAtoms: "399999",
  });
  assert.equal(partial.depositAmount, result.depositAmount);
  assert.equal(partial.expectedUsdgAtoms, "1000000");
  assert.equal(partial.executionAvailable, false);
  await assert.rejects(
    planner.preview({ ...request, startingUsdgAtoms: "400001" }),
  );
  await assert.rejects(
    planner.preview({
      ...request,
      expectedUsdgAtoms: "300000",
      startingUsdgAtoms: "400000",
    }),
  );
});
test("an arrived payout larger than the reviewed budget cannot increase hypothetical spending or become an executable plan", async () => {
  let observed = 0n;
  const planner = new RobinhoodDepositPreviewPlanner(
    { rpcUrl: "http://rpc.invalid" },
    {
      ...deps,
      readState: async () => ({ ...state, token: 2237133n }),
      simulate: async (s) => {
        assert.equal(s.token, 1000000n);
        return deps.simulate();
      },
      assertFresh: async (s) => {
        observed = s.token;
      },
    },
    () => 1000000,
  );
  const result = await planner.preview({ ...request, startingUsdgAtoms: "0" });
  assert.equal(observed, 2237133n);
  assert.equal(result.depositAmount, "999635");
  assert.equal(result.expectedUsdgAtoms, "1000000");
  assert.equal(result.startingUsdgAtoms, "0");
  assert.equal(result.executionAvailable, false);
  for (const field of [
    "operation",
    "proposal",
    "calldata",
    "recoveryEnvelope",
    "intent",
  ])
    assert.equal(field in result, false);
});
