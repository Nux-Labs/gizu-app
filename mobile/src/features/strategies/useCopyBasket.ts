import { useCallback, useRef, useState } from "react";
import type { CopyLeg } from "@/domain/strategyCopy";
import { parseSwapView, swapGateway } from "@/features/swap/confidentialSwap";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";
import { useStrategyFollowerDeps } from "./useStrategyFollower";

export type StockLeg = Extract<CopyLeg, { kind: "stock" }>;
export type CopyProgress = {
  legs: StockLeg[];
  /** Index of the buy in progress, or null when nothing is running. */
  current: number | null;
  bought: boolean[];
  message: string | null;
  finished: boolean;
};

const idle: CopyProgress = { legs: [], current: null, bought: [], message: null, finished: false };

/**
 * Buys a basket's stocks one at a time through the confidential swap. Each buy is its own native
 * review and passkey approval, and only one swap can run at once, so the copy stops at the first
 * buy that doesn't complete and can continue with the rest later.
 */
export function useCopyBasket(onFinished: () => void) {
  const { swap: swapFor } = useStrategyFollowerDeps();
  const portfolio = useOptionalMainnetWallet();
  const [progress, setProgress] = useState<CopyProgress>(idle);
  const running = useRef(false);

  const run = useCallback(
    async (legs: StockLeg[], alreadyBought: boolean[] = legs.map(() => false)) => {
      if (running.current) return;
      running.current = true;
      const bought = [...alreadyBought];
      const update = (patch: Partial<CopyProgress>) =>
        setProgress((state) => ({ ...state, legs, bought: [...bought], ...patch }));
      try {
        // A basket of vaults and cash has nothing to buy here.
        if (legs.length === 0) {
          update({ finished: true });
          onFinished();
          return;
        }
        const swap = swapFor();
        if (!swap) {
          update({
            message: "Copying needs the confidential swap, which this build doesn't have.",
          });
          return;
        }
        const saved = await swap.getSwapStatus(swapGateway);
        if (saved.phase !== "NONE" && saved.phase !== "COMPLETE" && saved.phase !== "CANCELLED") {
          update({ message: "Finish or cancel your open swap in Exchange first, then copy." });
          return;
        }
        for (const [index, leg] of legs.entries()) {
          if (bought[index]) continue;
          update({ current: index, message: null, finished: false });
          let phase: string;
          try {
            phase = parseSwapView(
              await swap.startSwap(leg.address, leg.atoms.toString(), swapGateway, leg.chainId),
            ).phase;
          } catch {
            phase = "FAILED";
          }
          if (phase !== "COMPLETE") {
            const left = legs.filter((_, i) => !bought[i]).map((item) => item.symbol);
            update({
              current: null,
              message:
                phase === "PAUSED"
                  ? `${leg.symbol} is paused. Resume it in Exchange, then continue with ${left.join(", ")}.`
                  : `Stopped at ${leg.symbol}. Not bought yet: ${left.join(", ")}.`,
            });
            return;
          }
          bought[index] = true;
        }
        update({ current: null, message: null, finished: true });
        onFinished();
      } finally {
        running.current = false;
        void portfolio?.refreshAfterAction();
      }
    },
    [onFinished, portfolio, swapFor],
  );

  return {
    progress,
    start: (legs: StockLeg[]) => run(legs),
    /** Continues with the buys not made yet. */
    resume: () => run(progress.legs, progress.bought),
    reset: () => setProgress(idle),
  };
}
