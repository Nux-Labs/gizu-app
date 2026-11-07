import assert from "node:assert/strict";
import test from "node:test";
import {
  ceilDiv,
  mulDiv,
  erc20PaymasterCap,
  feeEnvelope,
  fundingFeeCap,
  fundingApproval,
  fundingApprovalUpperBound,
} from "../../../src/adapters/evm/gas-policy.ts";
import {
  stabilizePaymasterApproval,
  estimateWithFreshPaymaster,
} from "../../../src/adapters/evm/token-paymaster.ts";
import { decodeFunctionData, erc20Abi } from "viem";
const token = `0x${"11".repeat(20)}` as const,
  paymaster = `0x${"22".repeat(20)}` as const;
const word = (n: bigint, bytes: number) =>
  n.toString(16).padStart(bytes * 2, "0");
const data = (rate = 10n ** 18n + 1n) =>
  `0x0200${word(0n, 12)}${token.slice(2)}${word(1n, 16)}${word(rate, 32)}${word(0n, 100)}` as const;
const op = {
  callData: "0x" as `0x${string}`,
  paymaster,
  paymasterData: data(),
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 0n,
  callGasLimit: 1n,
  preVerificationGas: 1n,
  verificationGasLimit: 1n,
  paymasterPostOpGasLimit: 1n,
  paymasterVerificationGasLimit: 1n,
};
const cap = (o: typeof op) => erc20PaymasterCap(o, { token, rounding: "ceil" });
test("checked gas arithmetic makes protocol floor and conservative ceiling explicit", () => {
  assert.equal(erc20PaymasterCap(op, { token, rounding: "floor" }), 6n);
  assert.equal(cap(op), 7n);
  assert.equal(mulDiv(3n, 3n, 2n, "floor"), 4n);
  assert.equal(mulDiv(3n, 3n, 2n, "ceil"), 5n);
  assert.throws(() => mulDiv((1n << 256n) - 1n, 2n, 2n, "floor"));
  assert.throws(() => ceilDiv(-1n, 1n));
  assert.throws(() => ceilDiv(1n, 0n));
  assert.throws(() => mulDiv(1n << 256n, 1n, 1n, "floor"));
  for (const patch of [
    { verificationGasLimit: undefined },
    { maxFeePerGas: 0n },
    { maxPriorityFeePerGas: 2n },
    { paymasterData: "0x0201" + op.paymasterData.slice(6) },
    { paymasterData: data(0n) },
  ])
    assert.throws(() => cap({ ...op, ...patch } as typeof op));
});
test("fee envelope stops chasing smaller changing quotes", () => {
  let budget = 0n;
  budget = feeEnvelope(budget, 10000n, 105n, 100n);
  budget = feeEnvelope(budget, 10001n, 105n, 100n);
  assert.equal(feeEnvelope(budget, 10000n, 105n, 100n), 10502n);
});
test("shared approval estimates its exact encoding and handles a changed rate", async () => {
  let calls: any[] = [];
  let estimates = 0;
  const result = await stabilizePaymasterApproval({
    initial: op,
    calls: [{ to: token, data: "0x1234" }],
    allowance: 0n,
    token,
    paymaster,
    cap,
    encode: async (c) => {
      calls = c;
      return `0x${c.length.toString().padStart(2, "0")}`;
    },
    estimate: async (o) => {
      estimates++;
      return { ...o, paymasterData: data(2n * 10n ** 18n + 1n) };
    },
  });
  const approval = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
  assert.equal(approval.functionName, "approve");
  assert.ok(approval.args[1] >= cap(result));
  assert.ok(estimates >= 2);
  await assert.rejects(
    stabilizePaymasterApproval({
      initial: op,
      calls: [],
      allowance: 0n,
      token,
      paymaster,
      cap,
      encode: async () => "0x01",
      estimate: async (o) => ({ ...o, callData: "0x02" }),
    }),
    /calldata/,
  );
});
test("changed sponsorship must itself be estimated before the operation is returned", async () => {
  const estimated: string[] = [];
  let refreshes = 0;
  const result = await estimateWithFreshPaymaster(
    op,
    async (o) => {
      estimated.push(o.paymasterData);
      return {
        callGasLimit: 2n,
        preVerificationGas: 2n,
        verificationGasLimit: 2n,
      };
    },
    async () => {
      refreshes++;
      return {
        paymaster,
        paymasterData: data(2n * 10n ** 18n),
        paymasterPostOpGasLimit: 3n,
        paymasterVerificationGasLimit: 4n,
      };
    },
  );
  assert.ok(refreshes >= 2);
  assert.equal(estimated.at(-1), result.paymasterData);
  assert.equal(result.paymasterPostOpGasLimit, 3n);
});

import { readFileSync } from "node:fs";
import { assertPaymasterValidity } from "../../../src/adapters/evm/gas-policy.ts";
test("backend gas policy conforms to the same cross-language golden fixtures", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../../shared/gas-policy-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(vectors.version, "gizu-gas-v1");
  for (const v of vectors.arithmeticVectors)
    for (const rounding of ["floor", "ceil"] as const)
      assert.equal(
        mulDiv(
          BigInt(v.a),
          BigInt(v.b),
          BigInt(v.denominator),
          rounding,
        ).toString(),
        rounding === "floor" ? v.floor : v.ceiling,
        v.name,
      );
  for (const v of vectors.paymasterVectors) {
    const operation = {
      ...Object.fromEntries(
        Object.entries(v.gas).map(([k, n]) => [k, BigInt(n as string)]),
      ),
      maxFeePerGas: BigInt(v.maxFeePerGas),
      maxPriorityFeePerGas: 0n,
      paymasterData:
        `0x0200${word(0n, 12)}${token.slice(2)}${word(BigInt(v.postOpGas), 16)}${word(BigInt(v.exchangeRate), 32)}${word(0n, 100)}` as `0x${string}`,
    };
    assert.equal(
      erc20PaymasterCap(operation, { token, rounding: "floor" }).toString(),
      v.floorAtoms,
      v.name,
    );
    assert.equal(
      erc20PaymasterCap(operation, { token, rounding: "ceil" }).toString(),
      v.ceilingAtoms,
      v.name,
    );
    const swapCap = fundingFeeCap(operation, token, "swap"),
      earnCap = fundingFeeCap(operation, token, "earn");
    assert.equal(swapCap.toString(), v.floorAtoms, v.name);
    assert.equal(earnCap.toString(), v.ceilingAtoms, v.name);
    assert.equal(
      fundingApproval(swapCap, "swap").toString(),
      v.swapApprovalAtoms,
      v.name,
    );
    assert.equal(
      fundingApproval(earnCap, "earn").toString(),
      v.earnApprovalAtoms,
      v.name,
    );
  }
});
test("paymaster readiness rejects future validity and near-expiry sponsorship", () => {
  const header = (after: bigint, until: bigint) =>
    `0x0200${word(until, 6)}${word(after, 6)}${op.paymasterData.slice(30)}`;
  assert.throws(() => assertPaymasterValidity(header(1001n, 0n), token, 1000n));
  assert.throws(() => assertPaymasterValidity(header(0n, 1015n), token, 1000n));
  assert.equal(
    assertPaymasterValidity(header(0n, 1016n), token, 1000n).validUntil,
    1016n,
  );
  assert.throws(() =>
    assertPaymasterValidity(header(0n, 1030n), token, 1000n, 30n),
  );
  assert.equal(
    assertPaymasterValidity(header(0n, 1031n), token, 1000n, 30n).validUntil,
    1031n,
  );
});
test("exact final sponsorship keeps a measured gas envelope instead of oscillating", async () => {
  let estimates = 0;
  const result = await estimateWithFreshPaymaster(
    op,
    async () => ({
      callGasLimit: ++estimates % 2 === 1 ? 2n : 1n,
      preVerificationGas: 1n,
      verificationGasLimit: 1n,
    }),
    async () => ({
      paymaster,
      paymasterData: op.paymasterData,
      paymasterPostOpGasLimit: 1n,
      paymasterVerificationGasLimit: 1n,
    }),
  );
  assert.equal(result.callGasLimit, 2n);
  assert.equal(estimates, 2);
});

test("Swap approvals across small protocol caps satisfy unchanged native bounds", () => {
  for (let cap = 1n; cap <= 100n; cap++) {
    const approval = fundingApproval(cap, "swap");
    assert.ok(approval >= cap && approval <= cap + cap / 50n);
    assert.equal(fundingApprovalUpperBound(cap, "swap"), cap + cap / 50n);
    assert.equal(fundingApproval(cap, "earn"), mulDiv(cap, 101n, 100n, "ceil"));
  }
});
