import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  erc20Abi,
  toHex,
  getAddress,
} from "viem";
import type { Hex } from "viem";
import {
  withPinnedFork,
  simulateForkSequence,
} from "../../../src/adapters/earn/fork-simulation.ts";
import { simulateRobinhoodExit } from "../../../src/adapters/earn/robinhood-exit-planner.ts";
import {
  ROBINHOOD_PROFILE,
  robinhoodChain,
  robinhoodCalls,
} from "../../../src/adapters/earn/robinhood-vault.ts";
import { balance } from "../../../src/adapters/earn/vault.ts";
import type { RobinhoodState } from "../../../src/adapters/earn/robinhood-deposit-planner.ts";
const rpcUrl = process.env.EARN_TEST_ROBINHOOD_RPC_URL,
  anvilPath = process.env.EARN_TEST_ANVIL_PATH;
test(
  "real Robinhood fork verifies full and partial redemption using fork-only USDG fixture funds",
  { skip: !rpcUrl || !anvilPath, timeout: 60000 },
  async (t) => {
    const upstream = createPublicClient({
      chain: robinhoodChain,
      transport: http(rpcUrl!, { retryCount: 0, timeout: 12000 }),
    });
    const block = await upstream.getBlock();
    const ref = (b: typeof block) => ({
      number: b.number,
      hash: b.hash,
      timestamp: b.timestamp,
      baseFeePerGas: b.baseFeePerGas ?? 0n,
      gasUsed: b.gasUsed,
      gasLimit: b.gasLimit,
    });
    const owner = getAddress("0x1000000000000000000000000000000000000001");
    await withPinnedFork(
      {
        rpcUrl: rpcUrl!,
        anvilPath: anvilPath!,
        block: ref(block),
        chain: robinhoodChain,
        timeoutMs: 55000,
      },
      async (fork, signal) => {
        // Local test hosts can be much farther from the upstream RPC than the deployed backend.
        const client = createPublicClient({
          chain: robinhoodChain,
          transport: http(String(fork.transport.url), {
            retryCount: 0,
            timeout: 30000,
          }),
          cacheTime: 0,
        });
        const rpc = (method: string, params: unknown[]) =>
          client.request({ method, params } as never);
        await rpc("anvil_setBlockTimestampInterval", [0]);
        // Test-only balance fixture: the old historical donor has no spendable USDG.
        // Trace this owner's balance slot on the isolated fork and verify the exact override.
        // Production planning never funds a wallet or uses this storage override.
        const trace = (await rpc("debug_traceCall", [
          {
            to: ROBINHOOD_PROFILE.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner],
            }),
          },
          "latest",
          { disableStorage: true, disableStack: false, enableMemory: false },
        ])) as { structLogs: { op: string; stack: string[] }[] };
        const slots = [
          ...new Set(
            trace.structLogs
              .filter((log) => log.op === "SLOAD")
              .map(
                (log) =>
                  `0x${log.stack.at(-1)!.replace(/^0x/, "").padStart(64, "0")}` as Hex,
              ),
          ),
        ].reverse();
        let funded = false;
        for (const slot of slots) {
          const before =
            (await client.getStorageAt({
              address: ROBINHOOD_PROFILE.token,
              slot,
            })) ?? toHex(0n, { size: 32 });
          await rpc("anvil_setStorageAt", [
            ROBINHOOD_PROFILE.token,
            slot,
            toHex(10000000n, { size: 32 }),
          ]);
          try {
            funded =
              (await balance(client, ROBINHOOD_PROFILE.token, owner)) ===
              10000000n;
          } catch {
            funded = false;
          }
          if (funded) break;
          await rpc("anvil_setStorageAt", [
            ROBINHOOD_PROFILE.token,
            slot,
            before,
          ]);
        }
        assert.ok(
          funded,
          "Fork-only USDG fixture must verify its balance storage slot",
        );
        await rpc("anvil_impersonateAccount", [owner]);
        await rpc("anvil_setBalance", [owner, toHex(10n ** 24n)]);
        await simulateForkSequence(
          client,
          owner,
          (
            await robinhoodCalls(
              client,
              owner,
              "deposit",
              8000000n,
              block.timestamp + 600n,
            )
          ).calls,
          signal,
        );
        const state = async (): Promise<RobinhoodState> => ({
          owner,
          block: ref(await client.getBlock()),
          token: await balance(client, ROBINHOOD_PROFILE.token, owner),
          shares: await balance(client, ROBINHOOD_PROFILE.vault, owner),
          native: 0n,
          wrappedNative: 0n,
          nonce: BigInt(await client.getTransactionCount({ address: owner })),
          ownerCode: "0x",
          shareDecimals: 18,
        });
        const invested = await state();
        assert.ok(invested.shares > 0n);
        const withdrawalCalls = (
          await robinhoodCalls(
            client,
            owner,
            "withdraw",
            invested.shares,
            block.timestamp + 600n,
          )
        ).calls;
        const paymasterApproval = {
          to: ROBINHOOD_PROFILE.token,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [ROBINHOOD_PROFILE.paymaster, 50000n],
          }),
        };
        const config = {
          rpcUrl: String(client.transport.url),
          anvilPath: anvilPath!,
          timeoutMs: 25000,
        };
        const withdrawal = await simulateRobinhoodExit(
          config,
          invested,
          [paymasterApproval, ...withdrawalCalls],
          "withdrawal",
          invested.shares,
        );
        assert.equal(withdrawal.remainingShares, 0n);
        assert.ok(withdrawal.receivedToken > 0n);
        assert.equal(withdrawal.rows.length, 3);
        assert.equal(
          await balance(client, ROBINHOOD_PROFILE.vault, owner),
          invested.shares,
        );
        await simulateForkSequence(client, owner, withdrawalCalls, signal);
        const exited = await state();
        assert.equal(exited.shares, 0n);
        const amount = exited.token - 50000n;
        const returns = await simulateRobinhoodExit(
          config,
          exited,
          [
            paymasterApproval,
            {
              to: ROBINHOOD_PROFILE.token,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [
                  getAddress("0x3000000000000000000000000000000000000003"),
                  amount,
                ],
              }),
            },
          ],
          "return",
          amount,
        );
        assert.equal(returns.remainingToken, 50000n);
        assert.equal(returns.remainingShares, 0n);
        assert.equal(
          await balance(client, ROBINHOOD_PROFILE.token, owner),
          exited.token,
        );
        // Reinvest on the disposable fork and verify a requested portion plus its return
        // never removes the other shares. No request here sends to the upstream chain.
        await simulateForkSequence(
          client,
          owner,
          (
            await robinhoodCalls(
              client,
              owner,
              "deposit",
              8000000n,
              block.timestamp + 600n,
            )
          ).calls,
          signal,
        );
        const partialStart = await state(),
          selectedShares = partialStart.shares / 2n;
        const portionCalls = (
          await robinhoodCalls(
            client,
            owner,
            "withdraw",
            selectedShares,
            block.timestamp + 600n,
          )
        ).calls;
        const portion = await simulateRobinhoodExit(
          config,
          partialStart,
          [paymasterApproval, ...portionCalls],
          "withdrawal",
          selectedShares,
        );
        assert.equal(
          portion.remainingShares,
          partialStart.shares - selectedShares,
        );
        assert.ok(portion.remainingShares > 0n);
        assert.equal(
          await balance(client, ROBINHOOD_PROFILE.vault, owner),
          partialStart.shares,
        );
        await simulateForkSequence(client, owner, portionCalls, signal);
        const retained = await state(),
          returnAmount = portion.receivedToken - 50000n;
        const partialReturn = await simulateRobinhoodExit(
          config,
          retained,
          [
            paymasterApproval,
            {
              to: ROBINHOOD_PROFILE.token,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [
                  getAddress("0x3000000000000000000000000000000000000003"),
                  returnAmount,
                ],
              }),
            },
          ],
          "return",
          returnAmount,
        );
        assert.equal(partialReturn.remainingShares, retained.shares);
        assert.ok(partialReturn.remainingShares > 0n);
        assert.equal(
          partialReturn.remainingToken,
          retained.token - returnAmount,
        );
        t.diagnostic(
          JSON.stringify({
            referenceBlock: block.number.toString(),
            referenceHash: block.hash,
            withdrawalGas: withdrawal.rows.map((r) => r.actualGas.toString()),
            returnGas: returns.rows.map((r) => r.actualGas.toString()),
            shares: invested.shares.toString(),
            redeemed: withdrawal.receivedToken.toString(),
          }),
        );
      },
    );
  },
);
