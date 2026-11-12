import { investmentDestination } from "@/domain/earn/distribution";
import { assertNotAborted } from "./abort";
import type { EarnIntent } from "@/domain/earn/types";
import type { EarnLiquidityService } from "@/domain/earn/ethereumLiquidity";
import type { EarnRobinhoodService } from "@/domain/earn/robinhoodExecution";
import {
  assertReturnCredits,
  exitActivityRevision,
  parseExitSnapshot,
  type EarnExitCompletionService,
} from "@/domain/earn/exitCompletion";
export function createEarnExitCompletionService(
  baseUrl: string,
  services: {
    liquidity: Pick<EarnLiquidityService, "list">;
    robinhood: Pick<EarnRobinhoodService, "list">;
  },
  now = Date.now,
): EarnExitCompletionService {
  return {
    async check(intent: EarnIntent, signal) {
      assertNotAborted(signal);
      if (!baseUrl) throw Error("Exit checking is not configured.");
      const rows = await (
        intent.profileId === "ethereum-usdc" ? services.liquidity : services.robinhood
      ).list(intent);
      assertNotAborted(signal);
      const creditedReturnOperationIds = assertReturnCredits(rows, intent),
        controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, 20000);
      try {
        const r = await fetch(baseUrl.replace(/\/$/, "") + "/v1/earn/exit-snapshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profileId: intent.profileId,
            owner: investmentDestination(intent).address,
          }),
          signal: controller.signal,
        });
        if (!r.ok)
          throw Error("Fresh investment-wallet balances and prices could not be verified.");
        const raw = await r.json();
        assertNotAborted(controller.signal);
        const snapshot = parseExitSnapshot(raw, intent, now());
        return {
          snapshot,
          creditedReturnOperationIds,
          journalRevision: exitActivityRevision(rows),
          creditedReturns: rows
            .filter((row) => creditedReturnOperationIds.includes(row.operationId))
            .map(({ operationId, revision }) => ({ operationId, revision })),
          complete: snapshot.publicResidualReady,
        };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
