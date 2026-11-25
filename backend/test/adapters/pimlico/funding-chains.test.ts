import assert from "node:assert/strict";
import test from "node:test";
import { fundingChain } from "../../../src/adapters/pimlico/funding-chains.ts";

test("funding source selection pins each exact USDC origin independently of the target", () => {
  const base = fundingChain(8453),
    arb = fundingChain(42161);
  assert.equal(
    base.token.toLowerCase(),
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
  assert.equal(
    base.originAsset,
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  );
  assert.equal(
    arb.token.toLowerCase(),
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  );
  assert.equal(
    arb.originAsset,
    "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  );
  assert.equal(
    fundingChain(143).originAsset,
    "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
  );
  for (const id of [1, 4663, 43114, 196, 84532, NaN])
    assert.throws(() => fundingChain(id));
});
