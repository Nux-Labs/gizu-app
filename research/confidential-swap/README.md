# Standalone confidential Monad USDC → Robinhood asset swap

This retained standalone Node.js mainnet experiment informed the Swap flow; it is
not imported by the active mobile app. Local raw keys, fixed three-wallet splits
and harness retry commands do not describe the native stored-wallet implementation.
Use [native signer](../../docs/internal/NATIVE_SIGNER.md),
[trading internals](../../docs/internal/TRADING.md) and
[swap recovery](../../docs/internal/SWAP_FAILURES.md) for the app. Provider and
funded-run observations below retain their original September 2026 scope.

The harness is a copy of the [`confidental-routing`](../confidental-routing/README.md) runner extended with a Robinhood Chain (4663) destination; that folder is left unchanged. The design and privacy analysis are in [spec §6A](../outputs/confidential-balance-distribution-spec.md#6a-swap-destination--robinhood-assets). A tx-by-tx write-up of the live AMZN run is in [confidential-swap-tx-by-tx](../outputs/confidential-swap-tx-by-tx.md).

The flow is the same up to the payouts. SOURCE (F) holds USDC and no MON on Monad and pays its gas in USDC through Pimlico's ERC-20 paymaster. It shields the available USDC, capped at 10, into a confidential account C. C then pays out 30/30/40 through confidential Aurora routes to three fresh Robinhood wallets (A1..A3). Depending on the target, those wallets receive the asset directly or buy it with USDG.

No wallet prototype code is imported. `init` creates C's private key in `.local/confidential-key` (mode 0600) unless `CONFIDENTIAL_PK` is set. Keep that key and the ignored `.env` file: C controls the confidential balance.

## Standalone harness setup

Use Node.js 22 or newer. Run `npm ci`, copy `.env.example` to `.env`, and fill in `AURORA_API_KEY`, `PIMLICO_API_KEY`, `ONEINCH_API_KEY`, `SOURCE_PK`, `SOURCE_ADD` and `DEST1_ADD` through `DEST3_ADD`. `DEST{i}_PK` is required for the swap and Fusion commands of wallet `i`. The runner derives addresses from keys and rejects mismatches; it never prints keys or API keys. `DESTINATION` defaults to `robinhood`.

## Target set

`npm run assets` builds the target set and writes it to `.local/robinhood-assets.json`:

- Direct targets are Aurora's `hood` tokens ETH, WETH, USDe and USDG. The memecoins CASHCAT and PONS are excluded.
- Stock targets come from Robinhood's Stock Token list (`https://api.robinhood.com/rhj/assets`). A stock is kept if its onchain `symbol`/`decimals` match and a 1inch USDG → stock quote at `LIQUIDITY_REFERENCE_USDG` (default 1000) has at most `MAX_PRICE_IMPACT_BPS` (default 100) price impact against a 10 USDG probe. `ONEINCH_DELAY_MS` spaces the quote requests.

`TARGET` picks one symbol from that set.

## Direct target

Aurora delivers the target asset itself, so Ai needs no action and no gas:

```sh
npm run check
node --env-file=.env src/cli.mjs init
npm run assets
TARGET=USDG npm run quote                              # verify chains/tokens; quote funding and payouts
TARGET=USDG node --env-file=.env src/cli.mjs fund      # Monad USDC into C with USDC-paid gas
TARGET=USDG npm run status                             # repeat until credited
TARGET=USDG node --env-file=.env src/cli.mjs plan
TARGET=USDG node --env-file=.env src/cli.mjs payout 1  # then 2 and 3
TARGET=USDG npm run status                             # Robinhood Transfer logs, or balance delta for ETH
```

## Stock target

A stock target (or an ERC-20 direct target with `ROUTE=usdg_then_swap`) is paid out as USDG. Each Ai then buys the target through the 1inch v6 router in one ERC-4337 UserOperation, paying gas from its own USDG through Pimlico's ERC-20 paymaster with an EIP-7702 delegation. Run the direct sequence with `TARGET=AMZN`, then for each `i` in 1, 2, 3:

```sh
TARGET=AMZN node --env-file=.env src/cli.mjs swap-preview 1  # amount, max USDG gas, minimum output
TARGET=AMZN node --env-file=.env src/cli.mjs swap-send 1     # sign and submit Ai's UserOperation
TARGET=AMZN node --env-file=.env src/cli.mjs swap-status 1   # reconcile swap, gas and balances
```

`prepare` reruns the liquidity rule before any source transaction is signed. Every swap command requires:

- the payout to be delivered;
- Ai to hold 0 ETH;
- Ai's USDG balance to be positive and no larger than its confirmed receipt.

The swap amount plus the signed USDG fee cap equals that balance exactly. The router calldata is decoded and checked for source, destination, receiver, amount and minimum return (`SWAP_SLIPPAGE_BPS`, default 100). `ROBINHOOD_RPC_URL`, `ROBINHOOD_ASSET_ID`, `ROBINHOOD_USDG_CONTRACT` and `SWAP_ROUTER` override the defaults.

## Gasless stock purchase with 1inch Fusion

While Pimlico has no USDG gas quote on Robinhood, Ai can sell its USDG for a stock through 1inch Fusion instead of `swap-*`. Ai only signs off-chain: an EIP-2612 USDG permit for the Robinhood Limit Order Protocol (`0x5A705DE8982235a7fa45bB83dCaCf03a211389C7`) and a Fusion order. A resolver fills the order and pays the ETH gas, which is priced into the Dutch auction. The commands work on a `TARGET=USDG` run once payout `i` is delivered:

```sh
node --env-file=.env src/cli.mjs fusion-preview 3   # market quote, auction start/end, minimum; signs nothing
node --env-file=.env src/cli.mjs fusion-send 3      # within 10 minutes of the preview: permit + order, submit
node --env-file=.env src/cli.mjs fusion-status 3    # poll; on fill, reconcile the fill transactions
```

`FUSION_TARGET` (default `AMZN`) must be a stock in the pinned target set. `FUSION_PRESET` (default `fast`) chooses the auction. The minimum output is the preview's auction end amount minus `FUSION_SLIPPAGE_BPS` (default 100). `FUSION_API_URL` defaults to `https://api.1inch.com/fusion`, and the requests use `ONEINCH_API_KEY`.

Before signing, `fusion-send` requires 0 ETH in Ai, a USDG balance equal to the previewed amount and no more than the confirmed receipt. It also reproduces the token's `DOMAIN_SEPARATOR` and simulates the permit. It then validates the order: maker and receiver are Ai, the tokens and full amount match, the auction end is at least the minimum, the extension carries exactly this permit, and the order expires before the one-hour permit. The signed order and permit are saved in `state.fusion[i]` before submission. `fusion-status` accepts a fill only when the USDG debit equals the signed amount and AMZN to Ai reaches the minimum, with both balances matching and Ai still at 0 ETH.

Limits:

- **Cost at small size:** resolver gas is priced into the rate. On 27 September, orders of 0.21–0.33 USDG filled 18–29% below the market quote. The share shrinks as the order grows.
- **No automatic retry:** an `expired` or `cancelled` order, or one the relayer never accepted, leaves USDG in Ai and can be previewed and sent again. Any other state requires `fusion-status` first.
- **Partial fills:** the `fast` preset disallows them. A partial fill from another preset is recorded as `partially_filled` and not completed.
- **Correlation:** one 1inch key and one session send all three orders, so 1inch can link A1–A3. Close fill times let chain observers link them too.

## Recovery and limits

`.local/state.json` persists quotes, signed UserOperations and intents, hashes and progress with mode 0600. No retry command creates a new signature:

- `rebroadcast` resends the saved Monad funding operation.
- `resubmit i` resends a saved payout intent after a status check.
- `swap-resubmit i` resends a saved swap after a receipt check; run `swap-status i` first.

A failed swap leaves USDG in Ai and can be previewed again. A saved run cannot be continued under a different `DESTINATION`. `post-*` (A1 → A3) commands are refused for Robinhood runs because that transfer publicly links the wallets. The inherited Ethereum mode (`DESTINATION=ethereum`) is kept but belongs to the vault flow in `confidental-routing`.

Recorded provider limits and results (27 September 2026; not rechecked):

- **`swap-*` stock route blocked:** Pimlico returns no USDG token quote on Robinhood, so `swap-preview` stops with `No USDG gas quote from the Robinhood ERC-20 paymaster`. There is deliberately no ETH top-up fallback. Use the Fusion commands instead.
- **Direct targets:** only USDG quotes at the 10 USDC cap. WETH quoted only at about 200 USDC, and ETH and USDe returned no liquidity.
- **Aurora fee:** each Robinhood USDG payout carries a fixed 0.15 USDG withdraw fee, so a 30/30/40 split costs 0.45 USDG.
- **Settlement correlation:** all three payouts arrived from the same Aurora settlement sender, two in the same block.
- **Provider correlation:** the same Pimlico and 1inch API keys serve F and every Ai, so those providers can correlate the wallets.
- **Funded evidence:** 1.199201 USDC → three USDG payouts → 0.002210 AMZN across A1–A3 through Fusion, with 0 ETH in every Ai. See [spec §9](../outputs/confidential-balance-distribution-spec.md#27-september--gasless-1inch-fusion-usdg--amzn).

References: [Aurora quote API](https://docs.intents.aurora.dev/api-reference/swap-api-reference/request-a-quote), [Robinhood Chain connection](https://docs.robinhood.com/chain/connecting/), [1inch Classic Swap API](https://portal.1inch.dev/documentation/apis/swap/classic-swap/introduction), [1inch Fusion SDK](https://github.com/1inch/fusion-sdk).
