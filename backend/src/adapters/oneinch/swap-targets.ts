// Generated from shared/swap-targets-v1.json; a test keeps the two identical.
// Robinhood stock tokens a new buy may target, deepest USDG market first. The native engine pins the same list.
export const ROBINHOOD_BUY_TARGETS: readonly { symbol: string; address: string }[] = [
  { symbol: "QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" },
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { symbol: "SPCX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },
  { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { symbol: "META", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },
  { symbol: "USO", address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344" },
  { symbol: "MU", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" },
  { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
  { symbol: "GLD", address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e" },
  { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "SNDK", address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400" },
  { symbol: "CRWV", address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3" },
  { symbol: "SGOV", address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" },
  { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
  { symbol: "BE", address: "0x822CC93fFD030293E9842c30BBD678F530701867" },
  { symbol: "AMAT", address: "0x36046893810a7E7fCE501229d57dc3FC8c8716d0" },
  { symbol: "IBM", address: "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619" },
  { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
  { symbol: "SLV", address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f" },
  { symbol: "LLY", address: "0x8005d266423c7ea827372c9c864491e5786600ea" },
  { symbol: "RDDT", address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C" },
  { symbol: "MRVL", address: "0x62fd0668e10D8B72339BE2DCF7643001688ff13B" },
  { symbol: "TTWO", address: "0x5e81213613b6B86EaB4c6c50d718d34359459786" },
  { symbol: "INTC", address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681" },
  { symbol: "AVGO", address: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF" },
];

const ranks = new Map(ROBINHOOD_BUY_TARGETS.map((target, index) => [target.address.toLowerCase(), index]));

/** Position in the liquidity ranking, or undefined when a buy may not target the token. */
export function robinhoodBuyRank(address: string): number | undefined {
  return ranks.get(address.toLowerCase());
}
