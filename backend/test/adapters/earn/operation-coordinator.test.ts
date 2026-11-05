import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "../../../src/adapters/earn/operation-coordinator.ts";
/** Shared adapter contract with database-clock expiry, no payload persistence. */
function sharedStore() {
  const rows = new Map<string, { commitment: string; expires: number }>();
  let now = 1000;
  return {
    rows,
    advance: () => {
      now += 10000;
    },
    async bind(
      key: string,
      commitment: string,
      expires: number,
      exclusive: boolean,
    ) {
      const old = rows.get(key);
      if (old && old.expires > now)
        return !exclusive && old.commitment === commitment;
      rows.set(key, { commitment, expires });
      return true;
    },
  };
}
test("replicas atomically share opaque bindings and single-send claims", async () => {
  assert.ok(implementation, "shared coordinator must exist");
  const store = sharedStore();
  const first = new implementation.OperationCoordinator(store, "ab".repeat(32)),
    second = new implementation.OperationCoordinator(store, "ab".repeat(32));
  const address = "0x" + "11".repeat(20);
  await first.bind(
    "payout-role",
    address,
    { operationId: "native-1", recipient: address },
    5000,
  );
  await second.bind(
    "payout-role",
    address,
    { operationId: "native-1", recipient: address },
    5000,
  );
  await assert.rejects(
    second.bind(
      "payout-role",
      address,
      { operationId: "native-2", recipient: address },
      5000,
    ),
  );
  assert.deepEqual(
    await Promise.all([
      first.claim("send", address, { signedData: "private" }, 5000),
      second.claim("send", address, { signedData: "private" }, 5000),
    ]),
    [true, false],
  );
  const saved = JSON.stringify([...store.rows]);
  assert.equal(saved.includes(address), false);
  assert.equal(saved.includes("private"), false);
  assert.equal(saved.includes("native-1"), false);
  store.advance();
  assert.equal(
    await second.claim("send", address, { signedData: "private" }, 15000),
    true,
  );
});
test("coordination storage errors fail closed without leaking provider details", async () => {
  assert.ok(implementation, "shared coordinator must exist");
  const c = new implementation.OperationCoordinator(
    {
      bind: async () => {
        throw new Error("address bearer signature");
      },
    },
    "ab".repeat(32),
  );
  await assert.rejects(
    c.claim("send", "opaque", {}, 5000),
    (error: any) =>
      error.code === "EARN_COORDINATION_UNAVAILABLE" &&
      error.statusCode === 503 &&
      !error.message.includes("bearer"),
  );
});
