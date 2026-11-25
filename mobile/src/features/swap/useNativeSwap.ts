import { isSwapChain, tokenIdentity, type CatalogToken } from "@/domain/tokenCatalog";
import { useCallback, useEffect, useState } from "react";
import {
  formatTokenAtoms,
  loadSwapTokens,
  previewSwapOut,
  parseSwapView,
  sourceAtoms,
  swapGateway,
  swapSigner,
  swapGasMessage,
  type ListedToken,
} from "./confidentialSwap";
import type { StoredSwapView } from "@/domain/wallet/storedSigner";
import { useOptionalMainnetWallet } from "@/features/wallet/MainnetWalletProvider";

type SwapAction =
  "start" | "payout" | "sell" | "resume" | "cancel" | "refresh" | "tokens" | "status";
function diagnostic(action: SwapAction, outcome: "started" | "completed" | "failed") {
  if (__DEV__) console.info("[swap]", { action, outcome });
}

// Later picker metadata wins over the initial request, including differently cased addresses.
function mergeTokens(older: ListedToken[], newer: ListedToken[]): ListedToken[] {
  return [...new Map([...older, ...newer].map((token) => [tokenIdentity(token), token])).values()];
}

export function useNativeSwap() {
  const portfolio = useOptionalMainnetWallet();
  const [tokens, setTokens] = useState<ListedToken[]>([]);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [fundingAddress, setFundingAddress] = useState("");
  const [status, setStatus] = useState<StoredSwapView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const native = swapSigner();
    const deposit = await native.getSwapDeposit();
    setFundingAddress(deposit.fundingAddress);
    try {
      const saved = await native.getSwapStatus(swapGateway);
      setStatus(saved.phase === "NONE" ? null : parseSwapView(saved));
    } catch {
      diagnostic("status", "failed");
      setError("Saved swap status unavailable. Refresh before starting another operation.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    loadSwapTokens()
      .then((list) => {
        if (!live) return;
        diagnostic("tokens", "completed");
        const initialTokens = mergeTokens([], list);
        setTokens((current) => mergeTokens(initialTokens, current));
        setTarget(
          (current) => current || initialTokens.find((t) => t.buyable !== false)?.address || "",
        );
      })
      .catch((cause: unknown) => {
        diagnostic("tokens", "failed");
        if (live) setError(cause instanceof Error ? cause.message : "Token list unavailable.");
      });
    queueMicrotask(() => {
      if (live) refresh().catch(() => diagnostic("refresh", "failed"));
    });
    return () => {
      live = false;
    };
  }, [refresh]);

  async function run(name: SwapAction, action: () => Promise<void>) {
    diagnostic(name, "started");
    setBusy(true);
    setError("");
    try {
      await action();
      diagnostic(name, "completed");
    } catch (cause) {
      diagnostic(name, "failed");
      const message = cause instanceof Error ? cause.message : "";
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      setError(
        swapGasMessage(typeof code === "string" ? code : message) ??
          (message === "HTTP"
            ? "A balance or swap service could not complete the request. Pull to refresh and check the saved swap status before trying again."
            : message === "Enter a positive USDC amount with at most six decimal places." ||
                message === "Confidential swap is unavailable in this build."
              ? message
              : "Swap stopped. Refresh the saved swap status before trying again."),
      );
    } finally {
      setBusy(false);
      void portfolio?.refreshAfterAction();
    }
  }

  const atoms = sourceAtoms(amount);
  const [estimate, setEstimate] = useState<{ key: string; text: string } | null>(null);
  const targetToken = tokens.find((token) => token.address === target);
  const decimals = targetToken?.decimals ?? 0;
  // The catalog adapter resolves legacy Robinhood responses; an unknown selection has no chain.
  const targetChain =
    targetToken && isSwapChain(targetToken.chainId) ? targetToken.chainId : undefined;
  const eligibleTarget =
    targetChain !== undefined &&
    targetToken?.swapListed === true &&
    targetToken.buyable !== false &&
    /^0x[0-9a-fA-F]{40}$/.test(target);
  const previewable = !!atoms && !!fundingAddress && decimals > 0 && eligibleTarget;
  const estimateKey = `${atoms}:${targetChain}:${target.toLowerCase()}`;
  useEffect(() => {
    if (!previewable || targetChain === undefined) return;
    let live = true;
    const key = estimateKey;
    const timer = setTimeout(() => {
      previewSwapOut(fundingAddress, target, atoms, undefined, targetChain)
        .then((out) => {
          if (live) setEstimate({ key, text: formatTokenAtoms(out, decimals) });
        })
        .catch(() => {
          if (live) setEstimate({ key, text: "" });
        });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [previewable, atoms, fundingAddress, target, decimals, targetChain, estimateKey]);
  return {
    // Only a result for the current amount and token is shown; a failed lookup shows nothing.
    estimate: !previewable
      ? null
      : estimate?.key !== estimateKey
        ? { text: "", loading: true }
        : estimate.text
          ? { text: estimate.text, loading: false }
          : null,
    tokens,
    target,
    targetChain,
    setTarget,
    selectToken: (token: CatalogToken) => {
      const chainId = token.chainId;
      if (!isSwapChain(chainId) || !token.swapListed || token.buyable === false || busy) return;
      setTokens((current) => mergeTokens(current, [{ ...token, chainId }]));
      setTarget(token.address);
    },
    amount,
    setAmount,
    fundingAddress,
    status,
    busy,
    error,
    canStart: !!atoms && eligibleTarget && !busy,
    canSell:
      status?.phase === "COMPLETE" &&
      status.direction === "buy" &&
      !!status.receivedTargetAtoms &&
      status.receivedTargetAtoms !== "0" &&
      !busy,
    start: () =>
      run("start", async () => {
        if (!atoms)
          throw new Error("Enter a positive USDC amount with at most six decimal places.");
        if (!eligibleTarget || targetChain === undefined)
          throw new Error("Choose a token to receive.");
        setStatus(
          parseSwapView(await swapSigner().startSwap(target, atoms, swapGateway, targetChain)),
        );
      }),
    // Only after a finished operation: a private balance left in C is spent without new funding.
    canPayout:
      status?.phase === "CANCELLED" &&
      /^[1-9]\d*$/.test(status.creditedAtoms) &&
      eligibleTarget &&
      !busy,
    sell: () =>
      run("sell", async () => {
        setStatus(parseSwapView(await swapSigner().startSell(swapGateway)));
      }),
    payout: () =>
      run("payout", async () => {
        if (!eligibleTarget || targetChain === undefined)
          throw new Error("Choose a token to receive.");
        setStatus(parseSwapView(await swapSigner().startPayout(target, swapGateway, targetChain)));
      }),
    resume: () =>
      run("resume", async () =>
        setStatus(parseSwapView(await swapSigner().resumeSwap(swapGateway))),
      ),
    cancel: () =>
      run("cancel", async () =>
        setStatus(parseSwapView(await swapSigner().cancelSwap(swapGateway))),
      ),
    refresh: () => run("refresh", refresh),
  };
}
