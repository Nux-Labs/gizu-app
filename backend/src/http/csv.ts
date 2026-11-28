/** Quote a CSV field and neutralize spreadsheet formulas in user-controlled values. */
export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
