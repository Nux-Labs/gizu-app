import type { TokenDetails } from "@/domain/tokenDetails";
export const tokenDetails: TokenDetails = {
  chainId: 4663,
  address: "0x" + "b".repeat(40),
  symbol: "GOOGL",
  name: "Alphabet Class A • Robinhood Token",
  logoURI: "https://example.com/googl.png",
  kind: "stock",
  description: "Alphabet is the parent company of Google, including Search, YouTube and Android.",
  isin: "US02079K3059",
  sharesPerToken: "1.000512",
  sessions: { regular: true, extended: true, overnight: false },
  priceUsd: 312.4,
  chart: {
    period: "1M",
    points: [
      { time: 1_790_000_000, price: 300 },
      { time: 1_790_086_400, price: 312.4 },
    ],
  },
};
