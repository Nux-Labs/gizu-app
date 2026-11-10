import { useEffect, useState } from "react";
import { formatTokenAtoms, previewSellOut } from "./confidentialSwap";
import { groupDigits } from "@/domain/wallet/amounts";

export type SellEstimate =
  { kind: "loading" } | { kind: "ready"; text: string } | { kind: "unavailable" };

/**
 * Gross USDC a sale of `tokenAtoms` would bring, for display only. It never signs or reserves
 * anything, so it also previews tokens the wallet does not hold yet.
 */
export function useSellEstimate(
  wallet: string,
  token: string | undefined,
  tokenAtoms: string | null,
): SellEstimate | null {
  const [result, setResult] = useState<{ key: string; text: string } | null>(null);
  const valid =
    !!tokenAtoms &&
    tokenAtoms !== "0" &&
    /^0x[0-9a-fA-F]{40}$/.test(wallet) &&
    /^0x[0-9a-fA-F]{40}$/.test(token ?? "");
  const key = `${token}:${tokenAtoms}`;
  useEffect(() => {
    if (!valid || !token || !tokenAtoms) return;
    let live = true;
    const timer = setTimeout(() => {
      previewSellOut(wallet, token, tokenAtoms)
        .then((out) => {
          if (live) setResult({ key, text: groupDigits(formatTokenAtoms(out, 6)) });
        })
        .catch(() => {
          if (live) setResult({ key, text: "" });
        });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [valid, wallet, token, tokenAtoms, key]);
  // Only a result for the current token and amount is shown.
  if (!valid) return null;
  if (result?.key !== key) return { kind: "loading" };
  return result.text ? { kind: "ready", text: result.text } : { kind: "unavailable" };
}
