import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, http, toHex } from "viem";
import type { Address, Hex, PublicClient, Chain } from "viem";
import { mainnet } from "viem/chains";
import {
  balance,
  depositCalls,
  redeemCalls,
  ETHEREUM_PROFILE,
} from "./vault.ts";
import type { ExactCall } from "./vault.ts";
import { mulDiv } from "../evm/gas-policy.ts";
import type { ReferenceBlock } from "./policy.ts";
export type SimulationRow = {
  to: string;
  data: string;
  estimatedGas: bigint;
  actualGas: bigint;
  hash?: Hex;
};
export type DepositSimulation = {
  deposit: SimulationRow[];
  withdrawal: SimulationRow[];
  previewShares: bigint;
  maxSharePrice: bigint;
  postDepositShares: bigint;
};
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Global bounded fork concurrency protects the host even across planner instances.
let activeForks = 0;
async function freePort() {
  const server = createServer();
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", yes);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No free fork port");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export async function withPinnedFork<T>(
  {
    rpcUrl,
    anvilPath,
    block,
    chain = mainnet,
    timeoutMs = 30000,
  }: {
    rpcUrl: string;
    anvilPath: string;
    block: ReferenceBlock;
    chain?: Chain;
    timeoutMs?: number;
  },
  fn: (client: PublicClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    throw new Error("Invalid simulation timeout");
  if (activeForks >= 2) throw new Error("Fork capacity unavailable");
  activeForks++;
  let child: ReturnType<typeof spawn> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    const port = await freePort();
    child = spawn(
      anvilPath,
      [
        "--fork-url",
        rpcUrl,
        "--fork-block-number",
        String(block.number),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        String(chain.id),
        "--hardfork",
        "prague",
        "--accounts",
        "0",
        "--silent",
        "--compute-units-per-second",
        "1000",
      ],
      { stdio: "ignore", env: { PATH: process.env.PATH } },
    );
    let failed = false;
    child.on("error", () => {
      failed = true;
      abort.abort();
    });
    const client = createPublicClient({
      chain,
      transport: http(`http://127.0.0.1:${port}`, {
        retryCount: 0,
        timeout: 10000,
      }),
      cacheTime: 0,
    });
    const work = async () => {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (failed || child!.exitCode !== null || abort.signal.aborted)
          throw new Error("Fork unavailable");
        try {
          ready = /anvil/i.test(
            await client.request({ method: "web3_clientVersion" }),
          );
        } catch {}
        if (ready) break;
        await pause(50);
      }
      if (!ready) throw new Error("Fork startup unavailable");
      const ref = await client.getBlock({ blockNumber: block.number });
      if (
        (await client.getChainId()) !== chain.id ||
        ref.number !== block.number ||
        ref.hash.toLowerCase() !== block.hash.toLowerCase() ||
        ref.timestamp !== block.timestamp ||
        (ref.baseFeePerGas ?? 0n) !== block.baseFeePerGas ||
        ref.gasUsed !== block.gasUsed ||
        ref.gasLimit !== block.gasLimit
      )
        throw new Error("Fork reference disagreement");
      return fn(client, abort.signal);
    };
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("Fork simulation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    abort.abort();
    if (timer) clearTimeout(timer);
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((r) => {
          if (child!.exitCode !== null) r();
          else child!.once("exit", () => r());
        }),
        pause(500),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise<void>((r) => child!.once("exit", () => r())),
          pause(500),
        ]);
      }
    }
    activeForks--;
  }
}
export async function simulateForkSequence(
  client: PublicClient,
  owner: Address,
  calls: ExactCall[],
  signal: AbortSignal,
): Promise<SimulationRow[]> {
  signal.throwIfAborted();
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(client.transport.url)) ||
    !/anvil/i.test(await client.request({ method: "web3_clientVersion" })) ||
    ![1, 4663].includes(await client.getChainId())
  )
    throw new Error("Simulation requires a server-local Anvil fork");
  const rpc = (method: string, params: unknown[]) =>
    client.request({ method, params } as never) as Promise<unknown>;
  const rows: SimulationRow[] = [];
  for (const call of calls) {
    signal.throwIfAborted();
    await rpc("anvil_setNextBlockBaseFeePerGas", ["0x0"]);
    const gas = await client.estimateGas({
      account: owner,
      ...call,
      maxFeePerGas: 10n ** 12n,
      maxPriorityFeePerGas: 0n,
    });
    if (gas <= 0n || gas > 10000000n)
      throw new Error("Unbounded simulation gas");
    const hash = (await rpc("eth_sendTransaction", [
      {
        from: owner,
        to: call.to,
        data: call.data,
        value: toHex(call.value ?? 0n),
        gas: toHex(mulDiv(gas, 150n, 100n, "ceil")),
        maxFeePerGas: toHex(10n ** 12n),
        maxPriorityFeePerGas: "0x0",
      },
    ])) as Hex;
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 5000,
      pollingInterval: 50,
    });
    if (receipt.status !== "success")
      throw new Error("Exact vault call reverted");
    rows.push({
      to: call.to,
      data: call.data,
      estimatedGas: gas,
      actualGas: receipt.gasUsed,
      hash,
    });
  }
  return rows;
}
/** Only fork ETH is overridden to measure fees. Real USDC is never fabricated. Redemption runs in this disposable fork solely to size a reserve. */
export async function simulateDeposit(options: {
  rpcUrl: string;
  anvilPath: string;
  timeoutMs?: number;
  block: ReferenceBlock;
  owner: Address;
  amount: bigint;
  initialShares: bigint;
}): Promise<DepositSimulation> {
  return withPinnedFork(options, (client, signal) =>
    simulateDepositOnFork(client, options, signal),
  );
}
export async function simulateDepositOnFork(
  client: PublicClient,
  options: {
    block: ReferenceBlock;
    owner: Address;
    amount: bigint;
    initialShares: bigint;
  },
  signal: AbortSignal,
): Promise<DepositSimulation> {
  signal.throwIfAborted();
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(client.transport.url)) ||
    !/anvil/i.test(await client.request({ method: "web3_clientVersion" })) ||
    (await client.getChainId()) !== 1
  )
    throw new Error("Simulation requires a server-local Anvil fork");
  const rpc = (method: string, params: unknown[]) =>
    client.request({ method, params } as never);
  if (
    (await balance(client, ETHEREUM_PROFILE.vault, options.owner)) !==
      options.initialShares ||
    (await balance(client, ETHEREUM_PROFILE.usdc, options.owner)) <
      options.amount
  )
    throw new Error("Unfunded or changed simulation state");
  await rpc("anvil_impersonateAccount", [options.owner]);
  await rpc("anvil_setBalance", [options.owner, toHex(10n ** 24n)]);
  const prepared = await depositCalls(
    client,
    options.owner,
    options.amount,
    options.block.timestamp + 600n,
  );
  const deposit = await simulateForkSequence(
      client,
      options.owner,
      prepared.calls,
      signal,
    ),
    postDepositShares = await balance(
      client,
      ETHEREUM_PROFILE.vault,
      options.owner,
    );
  if (postDepositShares <= options.initialShares)
    throw new Error("Deposit did not mint shares");
  const withdrawal = await simulateForkSequence(
    client,
    options.owner,
    await redeemCalls(
      client,
      options.owner,
      postDepositShares,
      options.block.timestamp + 600n,
    ),
    signal,
  );
  if ((await balance(client, ETHEREUM_PROFILE.vault, options.owner)) !== 0n)
    throw new Error("Full fork redemption left shares");
  return {
    deposit,
    withdrawal,
    previewShares: prepared.previewShares,
    maxSharePrice: prepared.maxSharePrice,
    postDepositShares,
  };
}
