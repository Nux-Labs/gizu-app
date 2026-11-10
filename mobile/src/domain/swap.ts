const USDC_DECIMALS = 6;

/** Decimal USDC text to 6-decimal atoms. Extra fraction digits and non-canonical forms are rejected. */
export function parseSwapAmount(amount: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(`${whole}${fraction.padEnd(USDC_DECIMALS, "0")}`);
}

/** 6-decimal USDC atoms to decimal text without trailing zeros. */
export function formatSwapAmount(atoms: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (atoms % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${atoms / scale}${fraction ? `.${fraction}` : ""}`;
}

/** Decimal token text to atoms at `decimals`. Extra fraction digits and non-canonical forms are rejected. */
export function parseTokenAmount(amount: string, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const fractionPattern = decimals > 0 ? `(?:\\.\\d{1,${decimals}})?` : "";
  if (!new RegExp(`^(?:0|[1-9]\\d*)${fractionPattern}$`).test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

/** User-facing direction of a swap, always "FROM → TO"; buy/sell wording is not shown. */
export function swapDirection(direction: "buy" | "sell" | string, symbol: string): string {
  const token = symbol || "token";
  return direction === "sell" ? `${token} → USDC` : `USDC → ${token}`;
}
