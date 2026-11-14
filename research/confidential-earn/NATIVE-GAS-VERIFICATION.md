> Scope reviewed 2026-11-14: this file documents the isolated research CLI and
> dated experiments. Its 10/90 payouts, 70/30 test budgets, full-exit gas/residual
> rules and separate confidential keys do not define current Android behavior.
> Current app contracts are [Confidential Earn](../../docs/internal/CONFIDENTIAL_EARN.md),
> [requested withdrawals/refunds](../../docs/internal/CONFIDENTIAL_WITHDRAWALS.md)
> and [native Earn](../../docs/internal/NATIVE_SIGNER_EARN.md). Android now uses
> algorithm-selected investment slots, shared Account-2 private cash and read access,
> requested partial Robinhood exits, and saved terminal return/refund evidence.
> iOS has narrower execution capabilities. Recorded hashes, amounts and test counts
> below remain historical; no live probes or native builds were run for this review.

# Fusion-funded native gas: local verification

**Integration update:** the flow is now implemented behind explicit native CLI commands. See [NATIVE-CLI.md](NATIVE-CLI.md) for commands and recovery. This document preserves the original five local cycle experiments; the separate CLI integration fixture tests the production runner with local provider write/status mocks.

The supplied API key worked during the recorded experiment. The new local harness executes **real unsigned Fusion quote terms against deployed Ethereum contracts on Anvil**, starting wallet 2 with zero ETH and zero USDC allowance to 1inch. It then deposits into the existing Morpho vault, redeems the shares, obtains a fresh Aurora `advanced` return quote, and transfers the remaining USDC to that quote's address **locally**.

**Corrected acceptance:** after returning to Aurora, the combined value of **ETH + USDC** left in the wallet must be below $0.50, ideally $0.10. The earlier test stopped after the USDC transfer and left ETH behind. Calling that a completed cycle measured the wrong endpoint. Prior balances are retained in [native-cycle-before-sweep.json](fixtures/native-cycle-before-sweep.json).

The updated harness adds a final native ETH return intent. Successful updated cases require **exactly zero ETH, zero USDC, and zero vault shares** after both local transfers. The 0.05-USDC balance during investment is an intermediate balance, not the final acceptance criterion. Public Fusion resolver acceptance and Aurora confidential credit remain unproved.

No mainnet transaction or signed Fusion order was submitted. Aurora return quotes were generated but never funded on mainnet. The existing `vault-send` command still uses Circle; the separate `native-*` commands implement this flow.

## What changed and why

The old Circle reserve bound was only an acceptance guard. Making a bid cheap enough to pass it does not make that bid includable. The historical 1.731762-USDC refund was predominantly unused gas allowance; lowering the gas price did not repair that gap. The previous report now explicitly calls the whole-reserve threshold a guard, not a fee solution.

The user-approved replacement purchases native ETH independently through an existing public Fusion settlement contract. The wallet then pays ordinary Ethereum transaction gas directly. Neither Pimlico nor Candide participates in this destination path, and Circle does not pull or refund USDC. Ethereum charges actual gas; unused **ETH stays in the wallet until the final native return intent sweeps it back**.

The source-chain paymaster, confidential account, and separate 20/80 payouts are unchanged. These tests begin at wallet 2 after its payout. They do not replay the entire source-to-confidential route again.

## Budget calculation

1. Simulate the actual deposit approval and SDK deposit, followed by approval and full redemption of the resulting shares. Use sequential `eth_estimateGas` against the resulting state.
2. Reserve estimated deposit gas plus **10% gas headroom**. Reserve estimated redemption gas plus **30% gas headroom**, at **2× the deposit fee cap**. These are explicit test policies, not fixed USDC fees or guarantees about future prices.
3. Size Fusion input against the **net native ETH received at auction end**, including resolver/protocol fees. The oracle price is only an initial sizing seed; it never authorizes funding. Re-quote the actual input until the net minimum covers the budget. An `insufficient amount` response increases the requested size within the affordable limit; other API failures propagate.
4. Re-simulate using the deposit amount remaining after that quoted purchase. If this changes the withdrawal gas path and increases the requirement, re-quote before purchasing. A real test exposed this state dependence; its regression test now covers it.
5. Validate quote age (60 seconds maximum), zero integrator/application fee, same maker/receiver, full-fill-only order, and native ETH output. Sign the exact USDC permit locally. Reconcile the full input debit and actual native output before building the deposit.
6. Deposit settled USDC minus 0.05. Re-estimate each operation and require ETH sufficient for its maximum upfront cost plus the reserved withdrawal amount. The local executor checks the estimate's block again before sending.
7. At withdrawal, simulate the complete sequence and check affordability **before paying even approval gas**. After withdrawal, obtain a fresh Aurora USDC quote, estimate that transfer, and budget the final native-ETH return too. Before sending away the USDC, confirm the conservative remaining ETH can fund a 21,000-gas sweep plus a viable native-input Aurora quote. If more ETH is necessary, obtain an Aurora quote for an input sized from the sweep's gas cost, then buy the ETH shortfall through Fusion and re-quote the changed USDC amount. There is no fixed-dollar native cleanup allowance. Provider refusal stops the flow; a funded USDC return alone is never completion.
8. After the USDC transfer, read the actual ETH balance and quote **native Ethereum ETH (`nep141:eth.omft.near`) → confidential USDC** for `balance − 21000 × gasPrice`. Require an empty-code Aurora deposit address, empty calldata, and a measured 21,000-gas transfer. Send a legacy transaction at that fixed gas price; reconcile the exact gas charge, recipient credit, and zero remaining ETH. Each return uses a separate fresh provider address; neither destination wallet sends to the other.
9. Assert the final combined balance using integer arithmetic, rounding the ETH valuation upward. Require no vault shares. The fork cases enforce the stronger result of both token balances being exactly zero.

A future fee rise can exceed any finite reserve. The 4× withdrawal test therefore stops with shares intact. It cannot promise withdrawal at arbitrary fees. Future vault liquidity and changed execution paths also require a fresh simulation.

`nativeFeeQuote` contains a next-block EIP-1559 calculation with a configurable inclusion horizon and withdrawal multiplier, tested separately. The end-to-end harness intentionally uses the historical **0.953266314-gwei** effective fee (0.753266314 base + 0.2 tip), then applies stated stress multipliers. It forces these block fees locally. It does not test a production live-market fee selection loop or public inclusion latency.

## Why the last transfer can have an exact remainder

For this restricted empty-code/empty-data native transfer, measured and actual gas are both 21,000. A legacy transaction pays its signed `gasPrice`; therefore `value + 21000 × gasPrice = wallet balance` leaves zero. It does not predict gas use inside Morpho or Circle. Ethereum's legacy normalization and fee accounting are specified in [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559).

The gas price must still be competitive and at least the inclusion base fee. If fees rise above it or the quote expires, do not call a pending transaction complete: reconcile its nonce/receipt and re-price/re-quote the amount for any replacement. This harness proves the arithmetic and execution at controlled fees; the native CLI now implements fresh live-price and same-nonce replacement planning, separately tested with local provider mocks. It does not obtain zero dust by deliberately underbidding or by donating the remainder as a fee.

## Recorded scenarios

| Updated local scenario                                                      | ETH returned in final sweep | Quoted confidential USDC from ETH (minimum) | Final ETH | Final USDC | Final shares |
| --------------------------------------------------------------------------- | --------------------------: | ------------------------------------------: | --------: | ---------: | -----------: |
| [first-payout-balance](fixtures/native-cycle-first-payout-balance.json)     |        0.000790601118026780 |                                    2.116464 |         0 |          0 |            0 |
| [larger-balance](fixtures/native-cycle-larger-balance.json)                 |        0.000685288322038195 |                                    1.833123 |         0 |          0 |            0 |
| [larger-balance-cycle-2](fixtures/native-cycle-larger-balance-cycle-2.json) |        0.000806624710261192 |                                    2.157256 |         0 |          0 |            0 |
| [withdrawal-1.8x](fixtures/native-cycle-withdrawal-1.8x.json)               |        0.000510205528792855 |                                    1.364505 |         0 |          0 |            0 |
| [return-16x](fixtures/native-cycle-return-16x.json)                         |        0.000613652324944613 |                                    1.641783 |         0 |          0 |            0 |

These five updated cycle executions passed. The two larger-balance cycles execute consecutively on the same fork/account state: the second begins after asserting the first ended at zero ETH/USDC/shares, then receives a new local payout fixture. Its USDC permit nonce and order state carry forward. No dust is discarded by resetting balances between those completed cycles.

The ETH return's minimum confidential USDC above is a **live quote**, not credited funds: both Aurora deposit transfers ran locally only. Actual ETH received by each local deposit address and actual 21,000-gas charges were asserted against receipts.

The 16× return case now budgets the final sweep **before the USDC return** and buys additional ETH while USDC is still available. In the previous version its leftover ETH could not fund a 21,000-gas transfer at that stressed fee. The historical underfunded bootstrap and 4× withdrawal-stop fixtures remain earlier negative tests; neither is reported as a completed zero-residual cycle.

Starting balances above the historical 3.592555 USDC are local fixtures: a locally impersonated existing pool supplies the difference before testing. This is not a proposed funding step. The initial 5.656266 value matches the original payout amount but is tested against the later pinned vault state.

These are counterfactual native-flow tests at parent block **26,079,549**, with current quote terms and auction times. They are not a claim that the new transactions happened historically. Exact old Circle financial/gas replays are recorded separately in [RESIDUAL-VERIFICATION.md](RESIDUAL-VERIFICATION.md).

## Proof and limits

**Proved locally:** gasless USDC-permit bootstrap from zero ETH/allowance; deployed LOP and quoted settlement execution; native ETH rather than WETH delivery; net auction-end amount accounting; approval/deposit/redemption/return transactions; 0.05-USDC post-deposit balance; zero ETH, USDC, and shares after successful updated local returns; exact native gas debits; insufficient-budget stops.

The resolver is one of the actual quote's allowed resolvers, **impersonated and funded only on Anvil**. Its willingness, inventory, off-chain admission checks, and eventual public fill are not proved. Quotes use `enableEstimate:false`; receiving a quote is not order admission. The 16× return stress uses actual unsigned quote terms but artificially higher local transaction fees; it does not prove that a commercial resolver would offer those terms in that stressed market.

Fresh Aurora quotes use the intended confidential recipient and advanced mode. Only the Ethereum USDC and native-ETH transfers execute locally, so Aurora receives no mainnet deposit and no off-chain confidential credit occurs. A real cycle is complete only after both routes succeed; refunds or pending routes must not be treated as completion. Public order acceptance and Aurora credit must be distinguished from these completed local checks.

**Privacy checks:** wallet 1 is absent from transaction calldata and logs, and its USDC, ETH, and vault-share balances remain unchanged. Wallet 2 uses existing public provider/SDK contracts; no new helper, shared application fee collector, wallet-to-wallet transfer, or joint destination transaction/order is introduced. Nonzero integrator fees are rejected. These checks cover the prohibited new mechanisms; they do not establish anonymity against timing/amount analysis or provider observation.

## Reproduce and inspect

Prerequisites: Node >=22, locked dependencies (`npm ci`), Anvil 1.8.3, and an archive RPC serving the pinned state. Keep `.env` and `.local/` private. `.env` requires the existing wallet configuration, `ONEINCH_API_KEY`, and `AURORA_API_KEY`; `.local/state.json` supplies the existing confidential return recipient and asset identifiers.

```sh
cd research/confidential-earn
npm test
anvil --fork-url https://eth.drpc.org --fork-block-number 26079549 --port 18564 --host 127.0.0.1 --hardfork prague --order fifo --accounts 0 --gas-price 0 --compute-units-per-second 80 --timeout 120000
```

In another terminal, run sequentially. `repeat-2` keeps the first cycle’s account/permit/order state for a second cycle, with another local payout fixture; it verifies zero balances before that second payout:

```sh
node --env-file=.env scripts/native-cycle-lab.mjs historical-balance
node --env-file=.env scripts/native-cycle-lab.mjs first-payout-balance
node --env-file=.env scripts/native-cycle-lab.mjs larger-balance repeat-2
node --env-file=.env scripts/native-cycle-lab.mjs withdrawal-1.8x
node --env-file=.env scripts/native-cycle-lab.mjs withdrawal-4x-blocked
node --env-file=.env scripts/native-cycle-lab.mjs return-16x
```

The execution URL is hardcoded to loopback. The script verifies Anvil, chain ID, and parent block before reading the key; snapshots are reverted after each scenario. Network requests obtain quotes only. Re-running obtains new quotes, so USDC purchases and resulting deposits vary; the tests assert accounting and acceptance properties, not a fixed gas-token purchase amount.

`fixtures/native-cycle-*.json` retain quote responses, budgets, fee/gas fields, transaction calldata/logs, local hashes, balances, and outcomes. Signed fill calldata, exact order and extension remain private in `.local/native-cycle-fill-<scenario>-<number>.json`. The last full unfunded USDC return quote is in `.local/native-cycle-return-quote.json`, and native return quotes are in `.local/native-cycle-native-return-<scenario>.json`; its public deposit address and minimum output are in each scenario fixture. No API key is stored in these results. The files plus pinned dependencies/state describe the tested transactions; an archive provider is still required. This is not a standalone offline state snapshot.

The ordinary suite at this checkpoint recorded **55 passing tests**. New coverage includes integer rounding, separate reserve policies, high-fee affordability, USDC residual limits, rejecting missing native output/partial debit, changed-block/expired-quote guards, amount-dependent re-quoting, small-order errors, net Fusion fees/native unwrap, stale provider terms, application-fee rejection, combined-asset completion, and native-sweep gas/code restrictions. Those guard tests are distinct from the successful deployed-contract fork executions. A separate review verified the quote-age and unwanted-fee fixes.
