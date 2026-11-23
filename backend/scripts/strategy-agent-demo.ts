// Demo agent for Sealed Strategies: it reads Gizu's public strategy cards, buys the best strategy's
// current basket with an x402 payment, checks the basket against the commitment sealed on the
// StrategyRegistry, and prints the allocation it would trade. It never trades itself.
//
// Usage (from backend/):
//   AGENT_PRIVATE_KEY=0x... node --experimental-transform-types scripts/strategy-agent-demo.ts \
//     [apiUrl=http://127.0.0.1:3100] [strategyId]
// Optional: AGENT_BUDGET_USDC (default 100), STRATEGY_RPC_URL (registry chain RPC),
// AGENT_SUBSCRIBER_KEY (read as a subscriber instead of paying per signal).
// The agent pays in USDC on the registry's network (Base Sepolia for the demo registry).
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ROBINHOOD_PROFILE } from "../src/adapters/earn/robinhood-vault.ts";
import { ETHEREUM_PROFILE } from "../src/adapters/earn/vault.ts";
import { strategyRegistryAbi } from "../src/adapters/evm/strategy-registry.ts";
import { BUY_TARGETS } from "../src/adapters/oneinch/swap-targets.ts";
import { STRATEGY_BASE_USDC } from "../src/adapters/strategies/universe.ts";
import { basketCommitment, type SealedStrategyAsset } from "../src/domain/strategy.ts";

type Card = {
  id: number;
  name: string;
  commits: number;
  revealed: number;
  signalPriceAtoms: string;
  performance: { cumulativeReturnBps: number | null; closedPeriods: number };
  registry: { chainId: number; address: Hex };
};
type Signal = {
  strategyId: number;
  signal: {
    seq: number;
    commitment: Hex;
    committedAt: string | null;
    commitTx: Hex | null;
    assets: SealedStrategyAsset[];
    salt: Hex;
  } | null;
};

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const api = (process.argv[2] ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const requestedId = process.argv[3] ? Number(process.argv[3]) : null;
const key = process.env.AGENT_PRIVATE_KEY ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("Set AGENT_PRIVATE_KEY to the agent wallet's 0x-prefixed key.");
const budgetAtoms = BigInt(Math.round(Number(process.env.AGENT_BUDGET_USDC ?? "100") * 1e6));
const account = privateKeyToAccount(key as Hex);
const usd = (atoms: bigint | string) => `$${(Number(atoms) / 1e6).toFixed(2)}`;

// 1. Read the public cards and pick the strategy with the best verified record.
const listed = await fetch(`${api}/v1/strategies`);
if (!listed.ok) fail(`Strategy list unavailable (${listed.status}).`);
const cards = ((await listed.json()) as { list: Card[] }).list.filter((card) => card.commits > 0);
const card =
  requestedId !== null
    ? cards.find((candidate) => candidate.id === requestedId)
    : [...cards].sort(
        (a, b) =>
          (b.performance.cumulativeReturnBps ?? -Infinity) - (a.performance.cumulativeReturnBps ?? -Infinity) ||
          b.commits - a.commits,
      )[0];
if (!card) fail("No strategy with a sealed basket was found.");
console.log(`Agent ${account.address}`);
console.log(
  `Strategy #${card.id} "${card.name}": ${card.commits} sealed, ${card.revealed} revealed, ` +
    `return ${card.performance.cumulativeReturnBps === null ? "not yet verified" : `${card.performance.cumulativeReturnBps / 100}%`}, ` +
    `signal price ${usd(card.signalPriceAtoms)}`,
);

// 2. Buy the current signal: the wrapper answers the 402 offer with a signed USDC authorization.
// The agent never signs for more than the price on the public card, whatever the 402 asks.
const maxPrice = BigInt(card.signalPriceAtoms);
const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: `eip155:${card.registry.chainId}`, client: new ExactEvmScheme(account) }],
  policies: [(_version, offers) => offers.filter((offer) => BigInt(offer.amount) <= maxPrice)],
});
// A subscribed agent (AGENT_SUBSCRIBER_KEY) reads with its key and pays nothing.
const subscriberKey = process.env.AGENT_SUBSCRIBER_KEY;
const response = await payingFetch(`${api}/v1/strategies/${card.id}/signal`, {
  method: "GET",
  headers: subscriberKey ? { "x-subscriber-key": subscriberKey } : {},
}).catch((error: unknown) =>
  fail(`No acceptable payment offer up to ${usd(maxPrice)}: ${error instanceof Error ? error.message : error}`),
);
if (!response.ok) fail(`Signal purchase failed (${response.status}): ${await response.text()}`);
const receipt = response.headers.get("PAYMENT-RESPONSE");
if (receipt) {
  const settled = decodePaymentResponseHeader(receipt);
  const paid = settled.amount === undefined ? "the card price" : usd(settled.amount);
  console.log(`Paid ${paid} from ${settled.payer} on ${settled.network}: ${settled.transaction}`);
} else {
  console.log("No payment was needed for this signal.");
}
const { signal } = (await response.json()) as Signal;
if (!signal) fail("The strategy returned no signal.");

// 3. Check the basket against the registry: same commitment recomputed and on chain.
const recomputed = basketCommitment(BigInt(card.id), BigInt(signal.seq), signal.assets, signal.salt);
const chain = card.registry.chainId === 8453 ? base : baseSepolia;
const reader = createPublicClient({ chain, transport: http(process.env.STRATEGY_RPC_URL) });
const onchain = await reader.readContract({
  address: card.registry.address,
  abi: strategyRegistryAbi,
  functionName: "commitAt",
  args: [BigInt(card.id), BigInt(signal.seq)],
});
const sealedAt = new Date(Number(onchain.committedAt) * 1000).toISOString();
if (recomputed.toLowerCase() !== signal.commitment.toLowerCase())
  fail("The basket does not hash to the commitment the API returned.");
if (onchain.commitment.toLowerCase() !== recomputed.toLowerCase())
  fail(`The registry holds another commitment for update ${signal.seq}.`);
console.log(`✓ Basket matches commitment ${recomputed} sealed on ${chain.name} at ${sealedAt} (update ${signal.seq}).`);

// 4. What the agent would trade with its budget; execution is left to the agent's own venue.
const labels = new Map<string, string>([
  [`8453:0:${STRATEGY_BASE_USDC.toLowerCase()}`, "USDC (cash)"],
  [`4663:1:${ROBINHOOD_PROFILE.vault.toLowerCase()}`, "Steakhouse USDG vault (Robinhood)"],
  [`1:1:${ETHEREUM_PROFILE.vault.toLowerCase()}`, "Pendle USDC vault (Ethereum)"],
  ...([4663, 8453] as const).flatMap((chainId) =>
    BUY_TARGETS[chainId].map(
      (target) =>
        [`${chainId}:0:${target.address.toLowerCase()}`, `${target.symbol} on ${chainId === 8453 ? "Base" : "Robinhood"}`] as [
          string,
          string,
        ],
    ),
  ),
]);
console.log(`Allocation for ${usd(budgetAtoms)}:`);
for (const asset of [...signal.assets].sort((a, b) => b.weightBps - a.weightBps)) {
  const label = labels.get(`${asset.chainId}:${asset.kind}:${asset.address.toLowerCase()}`) ?? asset.address;
  const amount = (budgetAtoms * BigInt(asset.weightBps)) / 10_000n;
  console.log(`  ${(asset.weightBps / 100).toFixed(0).padStart(3)}%  ${usd(amount).padStart(9)}  ${label}`);
}
