export function formatUsdc(atoms: string): string {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(atoms) || BigInt(atoms) >= 1n << 256n)
    throw new Error("Invalid USDC balance");
  const padded = atoms.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
export function formatMon(wei: string): string {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(wei)) throw new Error("Invalid balance");
  const padded = wei.padStart(19, "0");
  const whole = padded.slice(0, -18);
  const fraction = padded.slice(-18).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatGwei(wei: string): string {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(wei) || BigInt(wei) >= 1n << 256n)
    throw new Error("Invalid gas price");
  const padded = wei.padStart(10, "0"),
    whole = padded.slice(0, -9),
    fraction = padded.slice(-9).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Adds thousands separators to a plain decimal string ("12485.25" → "12,485.25"). */
export function groupDigits(value: string): string {
  const [whole = "", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Exact display of base units at `decimals`, trailing zeros trimmed and digits grouped. */
export function holdingAmount(atoms: string, decimals: number): string {
  const digits = atoms.padStart(decimals + 1, "0");
  if (!decimals) return groupDigits(digits);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return groupDigits(digits.slice(0, -decimals) + (fraction ? `.${fraction}` : ""));
}

/**
 * A token amount for display: at most `maxFraction` decimals, rounded down so a holding is never
 * overstated. A non-zero balance too small to show reads "<0.000001". Not for exact amounts
 * a user acts on, such as a sell's available balance.
 */
export function displayAmount(atoms: string, decimals: number, maxFraction = 6): string {
  const digits = atoms.padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = (decimals ? digits.slice(-decimals) : "")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  if (/^0+$/.test(whole) && !fraction && /[1-9]/.test(atoms))
    return `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return groupDigits(fraction ? `${whole}.${fraction}` : whole);
}
