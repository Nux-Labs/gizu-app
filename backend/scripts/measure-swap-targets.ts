/**
 * Measures 1inch aggregator price impact for issuer stock tokens and rewrites one chain's
 * buy list in shared/swap-targets-v2.json. Read-only: it only requests quotes, never signs
 * or submits anything.
 *
 *   node --experimental-transform-types scripts/measure-swap-targets.ts --chain 8453            # dry run, prints the list
 *   node --experimental-transform-types scripts/measure-swap-targets.ts --chain 8453 --write    # updates the shared file
 *
 * Options: --max-impact-bps <n> (default 100) at --size <usd> (default 25000), on both the buy and
 * the sell side; --top <n> keeps only the n deepest markets instead of every token under the cap;
 * --candidates <file> reads a saved issuer API response instead of fetching it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { resolveEnv } from "../src/secret/env-file.ts";

type Impact = Record<"1000" | "5000" | "25000", number>;
type Target = { symbol: string; address: string; impactBps: Impact; sellImpactBps?: Impact };
type ChainList = {
  name: string;
  settlementToken: { symbol: string; address: string; decimals: number };
  issuer: string;
  measuredAt: string;
  rule: string;
  targets: Target[];
};
type SharedList = { version: string; description: string; chains: Record<string, ChainList> };
type Candidate = { symbol: string; address: string; decimals: number };

const SIZES = [1000, 5000, 25000] as const;
const PROBE_USD = 10;
const FILE = new URL("../../shared/swap-targets-v2.json", import.meta.url);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries network failures, 429 and 5xx; returns any other response to the caller. */
async function fetchRetrying(url: string | URL, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch((error: unknown) => error as Error);
    if (response instanceof Response && response.status !== 429 && response.status < 500) return response;
    if (attempt === 5) throw new Error(`request kept failing: ${String(url).split("?")[0]} (${response instanceof Response ? response.status : response.message})`);
    await sleep(2000 * (attempt + 1));
  }
}

/** Reads one issuer API page: live, or from a saved response passed with --candidates. */
type Loader = (url: URL) => Promise<unknown>;

const CHAINS: Record<string, { name: string; issuer: string; stable: ChainList["settlementToken"]; candidates: (load: Loader) => Promise<Candidate[]> }> = {
  "4663": {
    name: "Robinhood Chain",
    issuer: "Robinhood",
    stable: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
    candidates: async (load) => {
      const body = (await load(new URL("https://api.robinhood.com/rhj/assets"))) as {
        assets: Array<{ tokenSymbol: string; tokenDecimals: number; status: string; deployments: Array<{ chainId: number; contractAddress: string }> }>;
      };
      return body.assets.flatMap((asset) =>
        asset.status !== "ASSET_STATUS_ACTIVE"
          ? []
          : asset.deployments
              .filter((d) => d.chainId === 4663)
              .map((d) => ({ symbol: asset.tokenSymbol, address: getAddress(d.contractAddress), decimals: asset.tokenDecimals })),
      );
    },
  },
  "8453": {
    name: "Base",
    issuer: "Coinbase",
    stable: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    candidates: async (load) => {
      const out: Candidate[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://api.coinbase.com/v1/tokenized-stocks");
        url.searchParams.set("page_size", "500");
        if (pageToken) url.searchParams.set("page_token", pageToken);
        const body = (await load(url)) as {
          tokens: Array<{ symbol: string; contract_address: string; decimals: number; paused_features?: string[] }>;
          next_page_token?: string;
        };
        for (const t of body.tokens) {
          if (t.paused_features?.length) continue;
          out.push({ symbol: t.symbol, address: getAddress(t.contract_address), decimals: t.decimals });
        }
        pageToken = body.next_page_token;
      } while (pageToken);
      return out;
    },
  },
};

const { values } = parseArgs({
  options: {
    chain: { type: "string" },
    "max-impact-bps": { type: "string", default: "100" },
    size: { type: "string", default: "25000" },
    top: { type: "string" },
    candidates: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const chainId = values.chain ?? "";
const chain = CHAINS[chainId];
if (!chain) throw new Error(`--chain must be one of ${Object.keys(CHAINS).join(", ")}`);
const maxBps = Number(values["max-impact-bps"]);
const size = Number(values.size) as (typeof SIZES)[number];
if (!SIZES.includes(size)) throw new Error(`--size must be one of ${SIZES.join(", ")}`);
const key = resolveEnv().ONEINCH_API_KEY?.trim();
if (!key) throw new Error("ONEINCH_API_KEY is not configured");

/** Destination amount for an exact-input quote, or null when 1inch has no route. */
async function quote(src: string, dst: string, amount: bigint): Promise<bigint | null> {
  const url = `https://api.1inch.com/swap/v6.1/${chainId}/quote?src=${src}&dst=${dst}&amount=${amount}`;
  const response = await fetchRetrying(url, { headers: { Authorization: `Bearer ${key}` } });
  await sleep(1100); // stay under the 1inch per-second limit
  if (!response.ok) return null;
  return BigInt(((await response.json()) as { dstAmount: string }).dstAmount);
}

const bps = (probeRate: number, rate: number) => Math.max(0, Math.round((1 - rate / probeRate) * 10_000));
const units = (usd: number, decimals: number) => BigInt(usd) * 10n ** BigInt(decimals);

/** Buy side: stable -> token, rate in token atoms per stable atom, compared with the probe. */
async function buyImpact(token: Candidate): Promise<{ impact: Impact; tokensPerUsd: number } | null> {
  const stable = chain.stable;
  const probe = await quote(stable.address, token.address, units(PROBE_USD, stable.decimals));
  if (!probe) return null;
  const probeRate = Number(probe) / PROBE_USD;
  const impact = {} as Impact;
  for (const usd of SIZES) {
    const out = await quote(stable.address, token.address, units(usd, stable.decimals));
    if (!out) return null;
    impact[`${usd}`] = bps(probeRate, Number(out) / usd);
    if (usd === size && impact[`${usd}`] > maxBps) break;
  }
  return { impact, tokensPerUsd: probeRate };
}

/** Sell side: the token amount worth each size at the probe price, sold back into the stable. */
async function sellImpact(token: Candidate, tokensPerUsd: number): Promise<Impact | null> {
  const stable = chain.stable;
  const amount = (usd: number) => BigInt(Math.floor(tokensPerUsd * usd));
  const probe = await quote(token.address, stable.address, amount(PROBE_USD));
  if (!probe) return null;
  const probeRate = Number(probe) / Number(amount(PROBE_USD));
  const impact = {} as Impact;
  for (const usd of SIZES) {
    const out = await quote(token.address, stable.address, amount(usd));
    if (!out) return null;
    impact[`${usd}`] = bps(probeRate, Number(out) / Number(amount(usd)));
  }
  return impact;
}

const saved = values.candidates;
const load: Loader = saved
  ? async () => JSON.parse(readFileSync(saved, "utf8")) as unknown
  : async (url) => (await fetchRetrying(url)).json() as Promise<unknown>;
const candidates = (await chain.candidates(load)).filter((c) => c.address.toLowerCase() !== chain.stable.address.toLowerCase());
console.error(`${candidates.length} ${chain.issuer} tokens on ${chain.name}; measuring…`);
const measured: Target[] = [];
for (const token of candidates) {
  const buy = await buyImpact(token);
  const passesBuy = buy && SIZES.every((usd) => buy.impact[`${usd}`] !== undefined) && buy.impact[`${size}`] <= maxBps;
  const sell = passesBuy ? await sellImpact(token, buy.tokensPerUsd) : null;
  const ok = passesBuy && sell !== null && sell[`${size}`] <= maxBps;
  console.error(`${token.symbol.padEnd(8)} buy=${JSON.stringify(buy?.impact ?? null)} sell=${JSON.stringify(sell)} ${ok ? "IN" : ""}`);
  if (ok) measured.push({ symbol: token.symbol, address: token.address, impactBps: buy.impact, sellImpactBps: sell });
}

// Deepest market first: buy impact at 25k, then 5k, then 1k; symbol breaks ties.
measured.sort(
  (a, b) =>
    a.impactBps["25000"] - b.impactBps["25000"] ||
    a.impactBps["5000"] - b.impactBps["5000"] ||
    a.impactBps["1000"] - b.impactBps["1000"] ||
    a.symbol.localeCompare(b.symbol),
);
const targets = values.top ? measured.slice(0, Number(values.top)) : measured;
const today = new Date().toISOString().slice(0, 10);
const rule = values.top
  ? `${targets.length} deepest ${chain.stable.symbol} markets by 1inch buy impact at ${size.toLocaleString("en-US")}`
  : `buy and sell impact at ${size.toLocaleString("en-US")} ${chain.stable.symbol} <= ${maxBps} bps against a ${PROBE_USD} ${chain.stable.symbol} probe`;
const list: ChainList = { name: chain.name, settlementToken: chain.stable, issuer: chain.issuer, measuredAt: today, rule, targets };

if (values.write) {
  const shared = JSON.parse(readFileSync(FILE, "utf8")) as SharedList;
  shared.chains[chainId] = list;
  writeFileSync(FILE, `${JSON.stringify(shared, null, 2)}\n`);
  console.error(`wrote ${targets.length} targets for chain ${chainId} to shared/swap-targets-v2.json`);
} else {
  console.log(JSON.stringify(list, null, 2));
}
