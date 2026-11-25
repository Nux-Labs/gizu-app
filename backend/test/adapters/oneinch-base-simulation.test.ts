import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  maxUint256,
  parseAbi,
  parseSignature,
  toHex,
} from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";

// Live, read-only: eth_simulateV1 on a Base RPC with state overrides and never-funded throwaway keys.
// Nothing is broadcast. Opt in with SWAP_TEST_BASE_RPC_URL and SWAP_TEST_ONEINCH_API_KEY.
const rpcUrl = process.env.SWAP_TEST_BASE_RPC_URL;
const apiKey = process.env.SWAP_TEST_ONEINCH_API_KEY;

const CHAIN_ID = 8453;
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LOP_V4: Address = "0x111111125421ca6dc452d289314280a0f8842a65";
const USDC_BALANCE_SLOT = 9n; // FiatToken v2.2 balanceAndBlacklistStates
const BUY_USDC = 100n * 10n ** 6n;

const tokenAbi = parseAbi([
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);
type Call = { from: Address; to: Address; data: Hex; value?: Hex };
type CallResult = { status: Hex; returnData: Hex; error?: { message: string } };
type SwapTx = { dstAmount: string; tx: { to: Address; data: Hex; value: string } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as T;
}

async function swapTx(src: Address, dst: Address, amount: bigint, from: Address): Promise<SwapTx> {
  const url = `https://api.1inch.com/swap/v6.1/${CHAIN_ID}/swap?src=${src}&dst=${dst}&amount=${amount}&from=${from}&origin=${from}&slippage=1&disableEstimate=true`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    await sleep(1100);
    if (response.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    assert.ok(response.ok, `1inch swap ${dst}: ${response.status}`);
    return (await response.json()) as SwapTx;
  }
  throw new Error("1inch rate limit");
}

async function permitDomain(token: Address) {
  const data = await rpc<Hex>("eth_call", [{ to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "eip712Domain" }) }, "latest"]);
  const [, name, version] = decodeFunctionResult({ abi: tokenAbi, functionName: "eip712Domain", data });
  return { name, version, chainId: CHAIN_ID, verifyingContract: token };
}

async function permit(owner: PrivateKeyAccount, token: Address, domain: Awaited<ReturnType<typeof permitDomain>>, spender: Address, value: bigint): Promise<Call> {
  const deadline = 2n ** 40n;
  const signature = parseSignature(
    await owner.signTypedData({
      domain,
      primaryType: "Permit",
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      message: { owner: owner.address, spender, value, nonce: 0n, deadline },
    }),
  );
  const v = signature.v ?? 27n + BigInt(signature.yParity ?? 0);
  return {
    from: owner.address,
    to: token,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "permit", args: [owner.address, spender, value, deadline, Number(v), signature.r, signature.s] }),
  };
}

const read = (token: Address, functionName: "balanceOf", who: Address): Call => ({
  from: who,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName, args: [who] }),
});
const allowance = (token: Address, owner: Address, spender: Address): Call => ({
  from: owner,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),
});
const amount = (result: CallResult) => (result.status === "0x1" ? BigInt(result.returnData) : -1n);

const targets = (
  JSON.parse(readFileSync(new URL("../../../shared/swap-targets-v2.json", import.meta.url), "utf8")) as {
    chains: Record<string, { targets: Array<{ symbol: string; address: Address }> }>;
  }
).chains["8453"]!.targets;

test(
  "every Base target buys with USDC, moves to a fresh wallet, permits and sells back without gas approvals",
  { skip: !rpcUrl || !apiKey, timeout: targets.length * 15_000 },
  async (t) => {
    const usdcDomain = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
    for (const target of targets) {
      await t.test(target.symbol, async () => {
        const buyer = privateKeyToAccount(generatePrivateKey());
        const holder = privateKeyToAccount(generatePrivateKey());
        const buy = await swapTx(USDC, target.address, BUY_USDC, buyer.address);
        const bought = BigInt(buy.dstAmount);
        const sellAmount = (bought * 45n) / 100n;
        const sell = await swapTx(target.address, USDC, sellAmount, holder.address);
        const calls: Call[] = [
          { from: buyer.address, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [buy.tx.to, maxUint256] }) },
          { from: buyer.address, to: buy.tx.to, data: buy.tx.data, value: toHex(BigInt(buy.tx.value || 0)) },
          read(target.address, "balanceOf", buyer.address),
          { from: buyer.address, to: target.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [holder.address, bought / 2n] }) },
          await permit(holder, target.address, await permitDomain(target.address), sell.tx.to, sellAmount),
          allowance(target.address, holder.address, sell.tx.to),
          { from: holder.address, to: sell.tx.to, data: sell.tx.data },
          read(USDC, "balanceOf", holder.address),
          await permit(buyer, USDC, usdcDomain, LOP_V4, BUY_USDC),
          allowance(USDC, buyer.address, LOP_V4),
        ];
        const usdcSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [buyer.address, USDC_BALANCE_SLOT]));
        const [block] = await rpc<Array<{ calls: CallResult[] }>>("eth_simulateV1", [
          {
            blockStateCalls: [{ stateOverrides: { [USDC]: { stateDiff: { [usdcSlot]: toHex(BUY_USDC, { size: 32 }) } } }, calls }],
            validation: false,
          },
          "latest",
        ]);
        const results = block!.calls;
        const failed = results.flatMap((result, index) => (result.status === "0x1" ? [] : [`call ${index}: ${result.error?.message ?? result.returnData}`]));
        assert.deepEqual(failed, []);
        assert.ok(amount(results[2]!) * 100n >= bought * 99n, "buy delivered less than the 1% slippage bound");
        assert.equal(amount(results[5]!), sellAmount, "stock permit did not set the allowance");
        assert.ok(amount(results[7]!) * 100n >= BigInt(sell.dstAmount) * 99n, "sell delivered less than the 1% slippage bound");
        assert.equal(amount(results[9]!), BUY_USDC, "USDC permit to the limit order protocol did not apply");
      });
    }
  },
);
