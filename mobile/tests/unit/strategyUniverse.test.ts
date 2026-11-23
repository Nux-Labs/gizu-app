import { readFileSync } from "fs";
import { join } from "path";
import { strategyStockTargets } from "@/domain/strategyUniverse";

type Shared = { chains: Record<string, { targets: { symbol: string; address: string }[] }> };

test("the strategy stock universe matches shared/swap-targets-v2.json, in order", () => {
  const shared = JSON.parse(
    readFileSync(join(__dirname, "../../../shared/swap-targets-v2.json"), "utf8"),
  ) as Shared;
  for (const chain of [4663, 8453] as const)
    expect(strategyStockTargets[chain]).toEqual(
      shared.chains[String(chain)]!.targets.map(({ symbol, address }) => ({ symbol, address })),
    );
});
