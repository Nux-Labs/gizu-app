Token logos are bundled so the portfolio does not wait for remote images.

- `usdc.png`: Gizu's `/v1/tokens` catalogue entry for Ethereum USDC,
  `https://tokens.1inch.io/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png`.
- `usdg.png`: Gizu's catalogue entry for Robinhood USDG,
  `https://assets.coingecko.com/coins/images/51281/small/GDN_USDG_Token_200x200.png?1730484111`.

Brand marks identify the corresponding tokens; they are not Gizu-created artwork.

`src/features/wallet/PortfolioAssetRow.tsx` selects these local images by chain and
token identity: USDC on Ethereum/Monad plus confidential Monad USDC use `usdc.png`,
and the Robinhood USDG contract uses `usdg.png`. Other catalogue assets may still
use remote `logoURI` images; the native Monad row uses the separate bundled Monad
mark. The URLs above record the bundled files' provenance, not a runtime download
requirement or a new verification of third-party licensing.
