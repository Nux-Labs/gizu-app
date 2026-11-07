import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  getAddress,
  toHex,
} from "viem";
import type { Hex } from "viem";
import {
  RobinhoodWithdrawalPlanner,
  RobinhoodReturnPlanner,
  robinhoodReturnProbeRecipient,
} from "../../../src/adapters/earn/robinhood-exit-planner.ts";
import type { RobinhoodExitProviders } from "../../../src/adapters/earn/robinhood-exit-planner.ts";
import { ROBINHOOD_PROFILE } from "../../../src/adapters/earn/robinhood-vault.ts";
import type { RobinhoodState } from "../../../src/adapters/earn/robinhood-deposit-planner.ts";
const now = Date.parse("2026-09-30T10:00:00Z"),
  owner = getAddress("0x1000000000000000000000000000000000000001"),
  C = getAddress("0x2000000000000000000000000000000000000002"),
  recipient = getAddress("0x3000000000000000000000000000000000000003");
const state: RobinhoodState = {
  owner,
  block: {
    number: 100n,
    hash: ("0x" + "11".repeat(32)) as Hex,
    timestamp: BigInt(now / 1000),
    baseFeePerGas: 1n,
    gasUsed: 1n,
    gasLimit: 30000000n,
  },
  token: 1000000n,
  shares: 12345n,
  native: 0n,
  wrappedNative: 0n,
  nonce: 2n,
  ownerCode: "0x",
  shareDecimals: 18,
};
const request = { owner, operationId: "exit_1", revision: 1 };
const abi = parseAbi([
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
function setup(
  patch: Partial<RobinhoodExitProviders> = {},
  s: RobinhoodState = state,
) {
  let quoted = 0;
  const amounts: bigint[] = [];
  const providers: RobinhoodExitProviders = {
    returnProbeRecipient: async () =>
      getAddress("0x0123456789abcdef102132435465768798a9bacb"),
    readState: async () => s,
    market: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    prepare: async (calls, fees) => {
      amounts.push(
        BigInt(
          calls[0]!.data.slice(-64) ? "0x" + calls[0]!.data.slice(-64) : "0",
        ),
      );
      return {
        operation: {
          sender: owner,
          nonce: "0x0",
          callData: encodeFunctionData({
            abi,
            functionName: "executeBatch",
            args: [
              calls.map((c) => ({
                target: c.to,
                value: c.value ?? 0n,
                data: c.data,
              })),
            ],
          }),
          signature: ("0x" + "ff".repeat(65)) as Hex,
          callGasLimit: "0x186a0" as Hex,
          verificationGasLimit: "0x186a0" as Hex,
          preVerificationGas: "0x186a0" as Hex,
          maxFeePerGas: toHex(fees.maxFeePerGas),
          maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
          paymaster: ROBINHOOD_PROFILE.paymaster,
          paymasterData: "0x" as Hex,
          paymasterPostOpGasLimit: "0x186a0" as Hex,
          paymasterVerificationGasLimit: "0x186a0" as Hex,
          eip7702Auth: {
            address: getAddress("0xe6Cae83BdE06E4c305530e199D7217f42808555B"),
            chainId: "0x1237" as Hex,
            nonce: "0x2" as Hex,
            r: ("0x" + "ff".repeat(32)) as Hex,
            s: ("0x" + "ff".repeat(32)) as Hex,
            yParity: "0x0" as Hex,
          },
        },
        feeCap: 10000n,
        fees,
        delegation: getAddress("0xe6Cae83BdE06E4c305530e199D7217f42808555B"),
        authorizationRequired: true,
        authorizationNonce: 2,
      };
    },
    withdrawalCalls: async () => [
      {
        to: ROBINHOOD_PROFILE.vault,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [ROBINHOOD_PROFILE.router, s.shares],
        }),
      },
    ],
    simulate: async (_state, calls, kind, amount) => ({
      rows: calls.map((c) => ({
        to: c.to,
        data: c.data,
        estimatedGas: 100000n,
        actualGas: 90000n,
      })),
      remainingShares: kind === "withdrawal" ? 0n : s.shares,
      remainingToken:
        kind === "withdrawal" ? s.token + 500000n : s.token - amount,
      receivedToken: kind === "withdrawal" ? 500000n : amount,
    }),
    assertFresh: async () => {},
    price: async () => ({ tokenPriceMicroUsdc: 1000000n, observedAtMs: now }),
    quote: async (input) => {
      quoted++;
      return {
        operationId: input.operationId,
        revision: input.revision,
        quoteId: ("0x" + "22".repeat(32)) as Hex,
        recipient,
        amountAtoms: input.amountAtoms,
        chainId: 4663,
        token: ROBINHOOD_PROFILE.token,
        confidentialAccount: C,
        refundOwner: owner,
        expiresAt: now / 1000 + 600,
        authenticatedBodyHash: ("0x" + "33".repeat(32)) as Hex,
        minimumCreditAtoms: "980000",
        originAsset:
          "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near",
        providerFeeBps: 2,
      };
    },
    ...patch,
  };
  return {
    providers,
    amounts,
    get quoted() {
      return quoted;
    },
  };
}
test("separate withdrawal previews every current share and real USDG fee reserve, without adding a future reserve", async () => {
  const f = setup();
  const p = await new RobinhoodWithdrawalPlanner(
    { rpcUrl: "test" },
    f.providers,
    () => now,
  ).plan(request);
  assert.equal(p.kind, "hoodRedeemAll");
  assert.equal(p.amountAtoms, "12345");
  assert.equal(p.maximumTokenFeeAtoms, "10500");
  assert.equal(p.retainedAfterActionAtoms, "0");
  assert.equal(p.previewRedeemedUsdg, "500000");
  assert.equal(p.fees.maxFeePerGasWei, "110");
  assert.equal(p.operation.signature, undefined);
  assert.equal(p.operation.eip7702Auth, undefined);
  assert.ok(Object.isFrozen(p));
});
test("withdrawal insufficient current reserve, zero shares and unresolved native assets reject", async () => {
  for (const changed of [
    { token: 10499n },
    { shares: 0n },
    { native: 1n },
    { wrappedNative: 1n },
  ]) {
    const f = setup({}, { ...state, ...changed });
    await assert.rejects(
      new RobinhoodWithdrawalPlanner(
        { rpcUrl: "test" },
        f.providers,
        () => now,
      ).plan(request),
    );
  }
});
test("withdrawal simulates the final bounded approval when sponsorship estimates change", async () => {
  let prepares = 0;
  let simulated: string | undefined;
  const f = setup({
    prepare: async (calls, fees) => {
      const p = await setup().providers.prepare(calls, fees);
      if (++prepares === 2) {
        p.operation.callData = encodeFunctionData({
          abi,
          functionName: "executeBatch",
          args: [
            [
              {
                target: ROBINHOOD_PROFILE.token,
                value: 0n,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [ROBINHOOD_PROFILE.paymaster, 10001n],
                }),
              },
              ...calls.map((c) => ({
                target: c.to,
                value: c.value ?? 0n,
                data: c.data,
              })),
            ],
          ],
        });
        p.feeCap = 10001n;
      }
      return p;
    },
    simulate: async (s, calls, kind, amount) => {
      simulated = calls[0]?.to;
      return setup().providers.simulate(s, calls, kind, amount);
    },
  });
  const p = await new RobinhoodWithdrawalPlanner(
    { rpcUrl: "test" },
    f.providers,
    () => now,
  ).plan(request);
  assert.equal(p.finalQuoteCapAtoms, "10001");
  assert.equal(simulated, ROBINHOOD_PROFILE.token);
  assert.equal(p.simulation.length, 2);
});
test("return converges both directions before exactly one quote, then estimates exact recipient and freezes binding", async () => {
  const f = setup({}, { ...state, shares: 0n });
  const p = await new RobinhoodReturnPlanner(
    { rpcUrl: "test" },
    undefined,
    f.providers,
    () => now,
  ).plan({ ...request, confidentialAccount: C });
  assert.equal(p.kind, "hoodTokenReturn");
  assert.equal(p.amountAtoms, "989500");
  assert.equal(p.maximumTokenFeeAtoms, "10500");
  assert.equal(p.maximumResidualUsdcAtoms, "10500");
  assert.equal(f.quoted, 1);
  assert.equal(p.route.recipient, recipient);
  assert.equal(p.route.amountAtoms, p.amountAtoms);
  assert.equal(p.finalQuoteCapAtoms, "10000");
  assert.equal(p.residualTargetMet, true);
  assert.ok(f.amounts.includes(500000n));
  assert.ok(f.amounts.includes(989500n));
});
test("return probes a verified empty recipient before quoting instead of a funded burn address", async () => {
  const empty = getAddress("0x0123456789abcdef102132435465768798a9bacb");
  const seen: string[] = [];
  const f = setup(
    {
      returnProbeRecipient: async () => empty,
      prepare: async (calls, fees) => {
        const transfer = decodeFunctionData({
          abi: erc20Abi,
          data: calls[0]!.data,
        });
        assert.equal(transfer.functionName, "transfer");
        const to = transfer.args![0] as string;
        seen.push(to);
        return {
          ...(await setup().providers.prepare(calls, fees)),
          feeCap:
            to.toLowerCase() === "0x000000000000000000000000000000000000dead"
              ? 17632n
              : 20033n,
        };
      },
    },
    { ...state, shares: 0n },
  );
  const plan = await new RobinhoodReturnPlanner(
    { rpcUrl: "test" },
    undefined,
    f.providers,
    () => now,
  ).plan({ ...request, confidentialAccount: C });
  assert.equal(seen[0], empty);
  assert.equal(plan.maximumTokenFeeAtoms, "21035");
  assert.equal(plan.amountAtoms, "978965");
  assert.equal(plan.finalQuoteCapAtoms, "20033");
  assert.equal(f.quoted, 1);
});
test("return probe rejects funded, low-calldata-cost and unresolved candidates", async () => {
  const calls: any[] = [];
  let reads = 0,
    generated = 0;
  const client = {
    readContract: async (request: any) => {
      calls.push(request);
      return reads++ === 0 ? 123n : 0n;
    },
  } as any;
  const result = await robinhoodReturnProbeRecipient(client, state, () => {
    generated++;
    return new Uint8Array(20).fill(generated === 1 ? 0 : generated);
  });
  assert.equal(result.toLowerCase(), "0x" + "03".repeat(20));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].blockNumber, state.block.number);
  assert.equal(calls[0].address, ROBINHOOD_PROFILE.token);
  assert.equal(calls[0].functionName, "balanceOf");
  await assert.rejects(
    robinhoodReturnProbeRecipient(
      { readContract: async () => 1n } as any,
      state,
      () => new Uint8Array(20).fill(4),
    ),
  );
  await assert.rejects(
    robinhoodReturnProbeRecipient(
      {
        readContract: async () => {
          throw Error("RPC unavailable");
        },
      } as any,
      state,
      () => new Uint8Array(20).fill(4),
    ),
  );
});
test("bound quote cannot silently change amount and exact-recipient fee increase rejects", async () => {
  let prepares = 0;
  const f = setup(
    {
      prepare: async (calls, fees) => {
        prepares++;
        return {
          ...(await setup().providers.prepare(calls, fees)),
          feeCap: prepares <= 2 ? 10000n : 10600n,
        };
      },
    },
    { ...state, shares: 0n },
  );
  await assert.rejects(
    new RobinhoodReturnPlanner(
      { rpcUrl: "test" },
      undefined,
      f.providers,
      () => now,
    ).plan({ ...request, confidentialAccount: C }),
  );
  assert.equal(f.quoted, 1);
});
test("return rejects malformed verified bindings before estimating or simulating the quote", async () => {
  for (const changed of [
    { recipient: "0x0000000000000000000000000000000000000000" },
    { quoteId: "0x00" },
    { authenticatedBodyHash: "0x00" },
    { minimumCreditAtoms: "0" },
    { expiresAt: now / 1000 + 601 },
  ]) {
    let finalSimulation = false;
    const f = setup(
      {
        quote: async (input) =>
          ({ ...(await setup().providers.quote(input)), ...changed }) as never,
        simulate: async (s, calls, kind, amount) => {
          finalSimulation = true;
          return setup().providers.simulate(s, calls, kind, amount);
        },
      },
      { ...state, shares: 0n },
    );
    await assert.rejects(
      new RobinhoodReturnPlanner(
        { rpcUrl: "test" },
        undefined,
        f.providers,
        () => now,
      ).plan({ ...request, confidentialAccount: C }),
    );
    assert.equal(finalSimulation, false);
  }
});
test("return fails closed on residual >=0.5, remaining shares, stale valuation and nonconvergence", async () => {
  for (const [patch, s] of [
    [
      {
        price: async () => ({
          tokenPriceMicroUsdc: 50000000n,
          observedAtMs: now,
        }),
      },
      { ...state, shares: 0n },
    ],
    [{}, { ...state, shares: 1n }],
    [
      {
        price: async () => ({
          tokenPriceMicroUsdc: 1000000n,
          observedAtMs: now - 300001,
        }),
      },
      { ...state, shares: 0n },
    ],
  ] as [Partial<RobinhoodExitProviders>, RobinhoodState][]) {
    const f = setup(patch, s);
    await assert.rejects(
      new RobinhoodReturnPlanner(
        { rpcUrl: "test" },
        undefined,
        f.providers,
        () => now,
      ).plan({ ...request, confidentialAccount: C }),
    );
    assert.equal(f.quoted, 0);
  }
  let n = 0;
  const f = setup(
    {
      prepare: async (calls, fees) => ({
        ...(await setup().providers.prepare(calls, fees)),
        feeCap: ++n % 2 === 0 ? 10000n : 11000n,
      }),
    },
    { ...state, shares: 0n },
  );
  await assert.rejects(
    new RobinhoodReturnPlanner(
      { rpcUrl: "test" },
      undefined,
      f.providers,
      () => now,
    ).plan({ ...request, confidentialAccount: C }),
  );
  assert.equal(f.quoted, 0);
});
import { robinhoodExitPrice } from "../../../src/adapters/earn/robinhood-exit-planner.ts";
import {
  monadUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
test("fresh relative USDG/USDC pricing rounds upward and rejects stale, duplicated or changed registry entries", () => {
  const tokens = [
    {
      assetId: robinhoodUsdgAssetId,
      blockchain: "hood",
      decimals: 6,
      contractAddress: ROBINHOOD_PROFILE.token,
      price: 1.000009,
      priceUpdatedAt: new Date(now).toISOString(),
    },
    {
      assetId: monadUsdcAssetId,
      blockchain: "monad",
      decimals: 6,
      contractAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      price: 0.999999,
      priceUpdatedAt: new Date(now).toISOString(),
    },
  ];
  assert.equal(
    robinhoodExitPrice({ tokens }, now).tokenPriceMicroUsdc,
    1000011n,
  );
  assert.throws(() =>
    robinhoodExitPrice({ tokens: [...tokens, tokens[0]] }, now),
  );
  assert.throws(() =>
    robinhoodExitPrice(
      {
        tokens: tokens.map((v) => ({
          ...v,
          priceUpdatedAt: new Date(now - 300001).toISOString(),
        })),
      },
      now,
    ),
  );
  assert.throws(() =>
    robinhoodExitPrice(
      { tokens: [{ ...tokens[0], contractAddress: owner }, tokens[1]] },
      now,
    ),
  );
});
