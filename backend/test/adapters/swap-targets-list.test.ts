import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress } from "viem";

type Impact = Record<"1000" | "5000" | "25000", number>;
type SharedList = {
  version: string;
  chains: Record<
    string,
    {
      settlementToken: { symbol: string; address: string; decimals: number };
      issuer: string;
      measuredAt: string;
      rule: string;
      targets: Array<{ symbol: string; address: string; impactBps: Impact; sellImpactBps?: Impact }>;
    }
  >;
};

const shared = JSON.parse(readFileSync(new URL("../../../shared/swap-targets-v2.json", import.meta.url), "utf8")) as SharedList;

test("every chain list is checksummed, unique, excludes its settlement token and is deepest first", () => {
  assert.equal(shared.version, "gizu-swap-targets-v2");
  assert.deepEqual(Object.keys(shared.chains).sort(), ["4663", "8453"]);
  for (const [chainId, list] of Object.entries(shared.chains)) {
    assert.ok(list.targets.length > 0, chainId);
    assert.match(list.measuredAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(list.settlementToken.address, getAddress(list.settlementToken.address));
    const addresses = list.targets.map((t) => t.address.toLowerCase());
    assert.equal(new Set(addresses).size, addresses.length, `${chainId} has duplicates`);
    assert.ok(!addresses.includes(list.settlementToken.address.toLowerCase()), `${chainId} lists its settlement token`);
    for (const target of list.targets) assert.equal(target.address, getAddress(target.address), target.symbol);
    const key = (i: Impact) => [i["25000"], i["5000"], i["1000"]];
    for (let i = 1; i < list.targets.length; i++) {
      const [a, b] = [key(list.targets[i - 1]!.impactBps), key(list.targets[i]!.impactBps)];
      const order = a.findIndex((value, k) => value !== b[k]!);
      assert.ok(order === -1 || a[order]! < b[order]!, `${chainId}: ${list.targets[i]!.symbol} is ranked out of order`);
    }
  }
});

test("Base targets are Coinbase stock tokens within 100 bps on both sides at 25,000 USDC", () => {
  const base = shared.chains["8453"]!;
  assert.equal(base.issuer, "Coinbase");
  assert.equal(base.settlementToken.address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  for (const target of base.targets) {
    assert.match(target.symbol, /c$/, target.symbol);
    assert.ok(target.address.toLowerCase().startsWith("0xb200"), `${target.symbol} is outside Coinbase's B20 address space`);
    assert.ok(target.impactBps["25000"] <= 100, `${target.symbol} buy impact`);
    assert.ok(target.sellImpactBps && target.sellImpactBps["25000"] <= 100, `${target.symbol} sell impact`);
  }
});
