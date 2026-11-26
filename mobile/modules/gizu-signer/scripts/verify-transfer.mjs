import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseTransaction, recoverTransactionAddress, keccak256 } from "viem";
const [from, hash, serializedTransaction] = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n");
const tx = parseTransaction(serializedTransaction);
assert.equal(tx.chainId, 10143);
assert.equal(tx.to.toLowerCase(), "0x" + "11".repeat(20));
assert.equal(tx.value, 1n);
assert.equal(tx.nonce, 0);
assert.equal(tx.gas, 21000n);
assert.equal(tx.maxFeePerGas, 100000000000n);
assert.equal(tx.maxPriorityFeePerGas ?? 0n, 0n);
assert.ok(!tx.data || tx.data === "0x");
assert.equal(tx.accessList?.length ?? 0, 0);
assert.equal(await recoverTransactionAddress({ serializedTransaction }), from);
assert.equal(keccak256(serializedTransaction), hash);
console.log("Native EIP-1559 signed bytes independently decoded and verified by viem.");
