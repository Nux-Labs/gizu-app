# Standalone Aurora confidential routing test

This retained standalone Node.js experiment is independent of the active Gizu
stored-wallet app. Its local private-key files, fixed 30/30/40 split and Circle
A1 → A3 step are harness behavior, not the mobile wallet's current signing or
recovery contract. For the app, see [native signer](../../docs/internal/NATIVE_SIGNER.md)
and [Confidential Earn](../../docs/internal/CONFIDENTIAL_EARN.md). Provider and
funded-run observations below retain their original September 2026 scope;
no current provider availability or balance is established by this README.

The harness can submit mainnet operations. The source wallet holds USDC on Monad; external public funding is outside this runner. The runner tests Pimlico's Monad ERC-20 paymaster for paying its first transfer fee in USDC, with no MON required in SOURCE. It transfers **the available USDC, capped at 10, minus the quoted maximum source gas cost** into a new confidential account C, then quotes three Aurora routes from C to the provided Ethereum addresses. It divides the authenticated private balance 30/30/40 when available. The original run fell back to the successful funding route's guaranteed minimum when account authentication failed; that proof format has since been corrected and the remaining balance read directly. Recipient amounts are whatever the three live quotes and settlement deliver after fees. After all three receipts settle, destination 1 sends its available Ethereum USDC to destination 3 using Circle's permissionless USDC Paymaster without ETH.

No wallet prototype code is imported. `init` creates C's private key in `.local/confidential-key` (mode 0600) unless `CONFIDENTIAL_PK` is set. Keep that key and the ignored `.env` file: C controls the confidential balance. The three destination private keys are optional and used only to check their addresses.

## Standalone harness setup

Use Node.js 22 or newer. Run `npm ci`, copy `.env.example` to `.env`, and fill in `AURORA_API_KEY`, `PIMLICO_API_KEY`, `SOURCE_PK`, `SOURCE_ADD`, `DEST1_PK`, and `DEST1_ADD` through `DEST3_ADD`. `DEST2_PK` and `DEST3_PK` are optional for the routing runner; this test does not spend from those wallets. The Aurora key comes from [Aurora Studio](https://studio.aurora.dev). The Pimlico key authenticates mainnet paymaster requests; gas is charged to SOURCE in USDC. The harness configures no Circle API key. The runner derives addresses from keys and rejects mismatches; it never prints keys or API keys. `MONAD_RPC_URL`, `ETHEREUM_RPC_URL` and `NEAR_RPC_URL` can override the public RPC defaults. The NEAR RPC supplies the current public `intents.near` salt for timestamped account-authentication proofs.

Run from this folder:

```sh
npm run check                    # local key/address validation
node --env-file=.env src/cli.mjs init
npm run tokens                   # inspect Aurora's USDC asset IDs
npm run quote                    # verify chains/tokens; quote source gas and shielding within 10 USDC
npm run status                   # read-only route/chain reconciliation
node --env-file=.env src/cli.mjs fund     # sends quoted USDC on Monad using USDC-paid gas
npm run status                   # repeat until credited in C
node --env-file=.env src/cli.mjs balance  # authenticated private balance view
node --env-file=.env src/cli.mjs plan     # quote three payouts under confirmed credit
node --env-file=.env src/cli.mjs payout 1
node --env-file=.env src/cli.mjs payout 2
node --env-file=.env src/cli.mjs payout 3
npm run status                   # inspect route status and Ethereum Transfer receipts
node --env-file=.env src/cli.mjs post-preview  # simulate A1 -> A3; show amount and maximum USDC gas
node --env-file=.env src/cli.mjs post-send     # sign and submit the public A1 -> A3 transfer
node --env-file=.env src/cli.mjs post-status   # reconcile transfer, Circle fee and refund
```

If an unsigned funding quote expires or its USDC gas estimate changes, run `requote`; if all payout quotes expire before any payout is signed, run `replan`. Review `prepare` output before `fund`, `plan` output before each payout, and `post-preview` before `post-send`. All chain transfers and intent submissions require the explicit `fund`, `payout`, or `post-send` command; `post-reprice` explicitly signs and submits a same-nonce replacement. `status`, `balance`, `tokens`, `prepare`, `plan`, and `post-preview` do not submit spending transactions. Aurora's quote API may still reserve or expire a deposit address. The source paymaster gas estimate is recomputed before signing; the command stops if it no longer fits the saved source budget, capped at 10 USDC.

Aurora's token registry is checked for one matching USDC asset on Monad, NEAR and Ethereum. If more than one appears, set the exact `MONAD_ASSET_ID` or `ETHEREUM_ASSET_ID` after inspecting `tokens`. `PRIVATE_ASSET_ID` is an explicit override only for a provider-verified alternative; optional contract filters are available too. The confidential shard uses an `imt:<shard-id>:<quote-asset-id>` token identifier, derived and checked against Aurora's generated unsigned payout intent. It verifies the source and destination contract's `symbol` and `decimals` on chain.

## No-key testnet gate

Before using mainnet funds, test the EIP-7702/Pimlico ERC-20 gas path on Ethereum Sepolia. Fund `SOURCE_ADD` with at least 3 faucet USDC from [Circle's public faucet](https://faucet.circle.com/) and keep its Sepolia ETH balance at zero. The command sends exactly 1 test USDC to `DEST1_ADD` and rejects a gas estimate above 2 test USDC. It does not call Aurora or touch mainnet.

```sh
node --env-file=.env src/testnet-source.mjs preview
node --env-file=.env src/testnet-source.mjs send
node --env-file=.env src/testnet-source.mjs status
```

The exact signed operation is stored in `.local/testnet-source-sepolia.json` before submission. A successful Sepolia result verifies the no-key testnet path only. Pimlico currently returns no USDC paymaster quote for Monad testnet, so Monad mainnet remains a separate gate. Thru has no verified deployment on Robinhood testnet in our checks.

## Recovery and limits

`.local/state.json` persists quotes, exact signed Monad and Ethereum UserOperations, signed intents, hashes, and progress with mode 0600. If submission times out, run `status` or `post-status` and inspect it before any retry. The runner does not create a second payment or intent automatically. If a source broadcast is unresolved, `rebroadcast` resends the saved signed UserOperation after a receipt and Aurora status check. If an intent submission is unresolved, `resubmit 1|2|3` resends the saved signed intent after a status check. If the A1 -> A3 transfer is unresolved, `post-resubmit` resends its exact saved UserOperation only while its next-block bid is current. `post-reprice` prepares, signs, and submits a same-nonce replacement using the current block, fresh priority quote, balance, and Circle permit; it saves previous hashes so `post-status` can reconcile whichever attempt lands. Repricing requires at least a 10% bump in both fee fields, and stops if a precise next-block bid cannot meet the bump or the balance cannot cover Circle's hold. Quote expiry stops new signing; start a fresh run only after reconciling old state. `status` checks Aurora route status, the Monad receipt, authenticated C balance when provider login works, and Ethereum USDC Transfer logs. A payout is marked delivered only when Aurora reports success and the recipient's observed transfer sum reaches the quote minimum. `post-status` requires the exact A1 -> A3 transfer log, Circle sponsorship event, and balances to reconcile before marking the run complete.

The A1 -> A3 transfer is public and directly links those two addresses. The runner computes Circle's maximum USDC prefund from the prepared EntryPoint gas limits, live `fetchPrice()`, `feeSpread()` and `additionalGasCharge()`; it repeats preparation until the signed permit amount and transfer fit A1's balance exactly. Circle refunds unused prefund after execution, so USDC can remain in A1. If A1's allocation cannot cover the maximum Ethereum gas prefund, `post-preview` stops before signing. In the 25 September 2026 mainnet run, A1 received 2.303576 USDC while the current Circle prefund quote was about 2.8 USDC, so A1 -> A3 was not sent. The three confidential payouts did settle.

The permit is an allowance, not an instruction to pay a chosen gas amount. [Circle's verified TokenPaymasterV08](https://eth.blockscout.com/address/0xdC57D57552256Df09FFEBED067bAA06eE49415f1) pulls the full prefund implied by the signed gas limits and maximum fee during validation, then refunds the difference after execution. Setting the permit to an estimated final fee plus 0.1 USDC without lowering those signed gas fields would fail validation. The completed vault-deposit example and exact prefund/final-charge arithmetic are recorded in [the separate earn experiment](../confidential-earn/README.md#why-the-vault-deposit-left-2464035-usdc). A1 -> A3 is a different operation and has no successful mainnet execution sample from which to copy its gas usage.

The Ethereum runner reads the latest block and derives the exact next block base fee under [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559), then adds Pimlico's live `slow` priority quote. It stops before signing if that reference block changed during preparation. The fixed fee used in the earn README's counterfactual is not a runtime setting. A fresh next-block bid can still leave more than 0.1 USDC after Circle's refund if inclusion misses that block or gas limits exceed actual use. Pimlico acceptance of the tighter bid and safe call limits for A1's current state remain unverified; no live A1 -> A3 operation has executed.

The runner now also models Circle's **final** charge using its verified `postOp` formula, including the effective gas price, extra charge, spread, and post-operation penalty; the test reproduces the completed vault transaction's 2.063812 USDC charge. During `post-status`, the observed A1 USDC balance change must equal Circle's `UserOperationSponsored.actualTokenNeeded`. The [wallet 2 vault gas-lab results](../confidential-earn/README.md#current-state-gas-limit-investigation) do not establish limits for A1's transfer: its account state and call data differ. A1 needs its own local-fork test before reducing the runtime limits.

The generated intent payload is parsed and checked against the approved C signer, `intents.far` confidential shard domain, exact token and source amount, quote deposit address, nonce and expiry before ERC-191 signing. A funded mainnet run on 25 September 2026 used `basic`; all three Ethereum payouts settled. The current runner uses `advanced`. Its funding and three payout quotes were accepted and unsigned payout intents were generated, but no `advanced` deposit or payout has been broadcast. The original ERC-191 account proof returned HTTP 401 because its nonce lacked the creation timestamp. The corrected `intents.near` proof now authenticates through Aurora; the balance API reports 0.098009 USDC available in C, exactly matching the funding quote's 9.800873 USDC expected credit minus 9.702864 USDC of private payouts. History currently returns HTTP 400 `History is invite-only for now`. It does not enforce a separate human transaction confirmation UI, and the raw private keys are available to this local process.

References: [Aurora quote API](https://docs.intents.aurora.dev/api-reference/swap-api-reference/request-a-quote), [Aurora authentication API](https://docs.intents.aurora.dev/api-reference/confidential-swaps-api-reference/authenticate-user-with-signed-data), [Aurora widget signing flow](https://github.com/aurora-is-near/intents-swap-widget/blob/efce388a8078f912d5f80dff25163d37b2f578c1/packages/intents-swap-widget/src/hooks/useMakeIntentsTransfer.ts).
