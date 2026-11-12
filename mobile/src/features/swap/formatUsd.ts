const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Token prices in dollars with cents, e.g. $1,234.56. */
export const formatUsd = (value: number) => usd.format(value);
