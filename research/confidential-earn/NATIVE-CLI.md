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

# Native earn commands

**Completed Ethereum mainnet cycle:** the revised Fusion order filled, wallet 2 deposited **1.084570 USDC**, redeemed all old/new shares for **1.218730 USDC**, and returned **1.268730 USDC + 0.000678997020223204 ETH** through separate Aurora intents. Both intents report SUCCESS; authenticated private credit is **3.081997 Monad-asset USDC**. Final wallet-2 balances are **zero ETH, USDC, WETH and shares**, meeting both residual targets. Wallet 1's ETH and USDC match its pre-test balances. No second Fusion purchase, helper, wallet-to-wallet transfer or joint destination transaction was used. [Mainnet evidence](fixtures/ethereum-mainnet-cycle.json).

**29 September fee/disclosure update:** Ethereum native bids use the full median of the last eight blocks' **25th-percentile** included priority fees, as approved by the user. The multiplier remains 1. This is a middle setting between the earlier 10th- and 40th-percentile choices; tips are recomputed rather than fixed in gwei. This is a bidding policy, not an inclusion guarantee. Same-nonce replacements retain the minimum 12.5% increase over their previous fee fields and must fit the wallet's budget; they remain explicit `reprice` actions, not an automatic escalation timer. The legacy Circle/bundler path is unchanged.

Deposit previews and execution print a combined `summary.message` before any Fusion authorization or native transaction signature. `totalBudgetETH` / `totalBudgetUSDC` now include deposit gas reserve, withdrawal gas reserve, and the quoted Fusion input-minus-net-output value (resolver execution/profit, protocol fees, price headroom). The resolver allowance is part of that difference and is never added twice. `fusionInputUSDC` is the full upfront purchase amount; `minimumETHReceived` and `extraPurchasedETH` distinguish usable ETH and additional funding headroom from swap costs. `depositGasBudgetETH` and `withdrawalGasReserveETH` expose the two gas budgets separately. This is a budget, not a claim that the entire reserve will be spent.

The displayed investable amount reconciles exactly as `initial wallet USDC − quoted Fusion input − 0.05 USDC retained`. Existing ETH reduces the purchase before quoting. An unaffordable quote reports zero investable USDC and no misleading combined total. `feeEstimate` provides the sampled tip and deposit/withdrawal caps in gwei. Aurora return fees are re-quoted after withdrawal and are explicitly excluded from this upfront deposit/withdrawal budget.

The fee/disclosure changes passed 108 unit/regression tests, including a regression using the audited low/high tip samples, cost disclosure before signing, unaffordable-budget disclosure, existing ETH credit and replacement fee requirements. No mainnet transaction or order was sent while changing the fee policy.

The native flow is now available in this experiment's CLI. It buys native ETH with Fusion only when needed, deposits into the existing vault, redeems, returns USDC to Aurora, then returns remaining ETH through a separate ETH-to-confidential-USDC quote. No helper contract, shared application fee, inter-wallet transfer, or joint destination order is introduced.

**Wallet 2 only.** The legacy 20/80 amounts remain in historical evidence; current `splitSourceBudget` and route commands use 10/90. The old `vault-*` commands still use Circle; use `native-*` for this flow. Wallet 1's funds are untouched.

## Resolver pricing after the two expired orders

The production planner now uses a full-fill **custom flat auction**, rather than trusting the fast preset's minimum output. Both the deposit bootstrap and any Aurora-return top-up include resolver economics. The equation is:

- `G = max(fresh provider gas, provider gasLimit, previously measured settlement floor of 202859) × 1.20`, rounded up. The measured floor is a lower bound, not a universal execution estimate.
- `P = current native fee cap × 1.25`, rounded up. The native cap still uses the approved full median of eight blocks' 25th-percentile priority fees.
- Resolver execution allowance = `G × P`; modeled profit allowance = 10% of that execution allowance. These are proportional policy margins, not fixed USDC fees or a known resolver profit requirement.
- Maximum gross ETH delivered = the USDC input's value at the quote's ETH/USDC prices minus both allowances. Include protocol fees, then reduce output by another 0.5% for price movement between quote requests.
- Request those terms from 1inch's custom endpoint with equal start/end amounts, a 180-second auction, and no partial/multiple fills. Check the returned curve, SDK-calculated gross payment, net native ETH and fresh prices. No application fee is added.
- Increase the USDC purchase until the **net ETH minimum** covers the measured deposit + withdrawal requirement. Re-simulate the smaller vault deposit. If unaffordable, stop with zero investable amount; do not sacrifice withdrawal funding.

Before signing, obtain another estimated custom quote with the actual permit. Preserve the more conservative preview gas estimate, repeat the economic/minimum-output checks, and retain the provider response and economics in the private journal. Quotes without the required fee plan cannot reach production order signing. Price/gas movement beyond the modeled budget may still cause an order to expire; this is not guaranteed resolver admission or inclusion. Provider gas estimates can be substantially larger than a direct fill from pre-funded resolver inventory, so the allowance is conservative.

The summary now displays resolver allowance in ETH/USDC, its total gas-price budget in gwei and modeled break-even gwei. The allowance is already inside `fusionInputUSDC`; do not add it a second time. It reduces investable USDC rather than leaving extra wallet dust. Aurora return remains separately quoted after withdrawal.

Verification: `npm test` and `node --env-file=.env scripts/fusion-economics-lab.mjs`. The latter pins current wallet state and replays the recorded 0.675754118/1.351508236 gwei fee scenario with fresh unsigned custom quotes. It strips permits from all public quote requests, intercepts estimated quote IDs locally, keeps signatures on loopback, checks fills at 1/90/180 seconds, then deposits and redeems all old/new shares using only the purchased ETH. It does not submit a public order or repeat Aurora return. Set `FUSION_LAB_BLOCK=26085368` for the original block when an archive RPC is available; the public RPC refused some historical state during this run. [Recorded fork evidence](fixtures/fusion-economics-lab.json).

## Configuration

Run from `research/confidential-earn` with Node >=22 and `npm ci`. Keep `.env` and `.local/` private. The existing Aurora/routing state must identify the same destination addresses, confidential account, and USDC assets as `.env`.

Native-only settings are `DEST2_ADD`, `DEST2_PK`, `DEST1_ADD`, `SOURCE_ADD`, `AURORA_API_KEY` and `ONEINCH_API_KEY`. Source funding/payout commands additionally require `SOURCE_PK`, `DEST1_PK` and `PIMLICO_API_KEY`. `ETHEREUM_RPC_URL`, when supplied, must be Ethereum mainnet and support historical state for the fresh local fork; the default is `https://ethereum-rpc.publicnode.com`. `ANVIL_PATH` is the path to Anvil (tested with 1.8.3); if unset, `anvil` must be on PATH.

The simulator spawns a temporary Anvil node on loopback, pins the selected mainnet block, executes the exact call sequence using local impersonation, and shuts it down. The simulator never receives the private key. It does not mutate mainnet or use fixed-dollar gas allowances.

## Commands

```sh
npm run native:preview                     # auto-select preview from current phase/shares
npm run native:preview -- deposit          # explicit deposit preview
npm run native:preview -- withdraw         # explicit withdrawal preview
npm run native:preview -- return           # explicit return preview
npm run native:status                      # reconcile receipts/orders/route statuses; never submit

npm run native:deposit                     # fund ETH if necessary, approve, then deposit
npm run native:withdraw                    # approve shares if needed, then redeem
npm run native:return                      # fund return if needed, return USDC, then sweep ETH
npm run native:reprice                     # replace an unresolved transaction at the same nonce
```

**Each execution command submits at most one transaction or Fusion order per invocation.** Wait for confirmation, inspect `native:status`, and repeat the same command until its stage finishes. This is intentional recovery behavior, not a request to start a second cycle.

Typical sequence:

1. `native:preview -- deposit`. If the wallet already owns shares from an earlier Circle run, use withdrawal preview instead. `native:withdraw` can adopt and redeem those existing shares using the wallet's existing ETH; it will refuse if the complete withdrawal cannot be funded.
2. Run `native:deposit`, check `native:status`, then repeat `native:deposit` as needed. The stage is finished at **`invested`**. The wallet owns the shares, retains 0.05 USDC, and keeps its variable ETH exit reserve.
3. When the user wants to exit, preview withdrawal. Run `native:withdraw` and status/repeat until **`withdrawn`**. The preflight checks the entire approval/redemption sequence before any approval is sent.
4. Preview return. Run `native:return` and status/repeat. Before returning all USDC, it verifies funding and an accepted native-input quote for the later ETH sweep. After the USDC receipt, it re-reads ETH, obtains the exact native quote, and sweeps it. **`awaiting_aurora` is not completion.**
5. Run `native:status` until **`complete`**. This requires both saved Aurora routes to report `SUCCESS`, no remaining vault shares, and combined ETH + USDC below 0.5 USDC in value. Each confirmed native sweep currently checks the stronger zero-ETH/zero-USDC result.

No automatic withdrawal follows a deposit. No new deposit follows completion unless the user invokes `native:deposit` again; prior cycle evidence remains in journal history.

## Amounts and pricing

- Deposit gas allowance: estimate +10%.
- Initial withdrawal reserve: estimate +30%, priced at twice the deposit fee cap.
- Fusion sizing uses minimum net native output, accounts for existing ETH, and re-simulates the changed deposit amount. There is no fixed USDC gas purchase.
- Return USDC transfer: fresh estimate +10%; both return steps are checked before sending USDC away.
- Final native transfer: verified empty-code destination, empty calldata, measured 21,000 gas, legacy fixed `gasPrice`. Its value is the actual ETH balance minus that exact transaction cost.
- Fee caps come from the current block, EIP-1559 next-block calculation, a two-block inclusion horizon, and recent included priority fees. A replacement raises the previous fee fields by at least 12.5% and still checks the fresh market.
- All financial amounts printed as `*Atoms`, `*Wei`, or integer balances are base units: USDC has 6 decimals and ETH has 18.

These buffers do not guarantee arbitrary future gas prices or vault liquidity. The CLI refuses stale plans, changed balances, insufficient funding, unsupported native return recipients, or rejected provider quotes before the affected submission.

## Saved operations and recovery

State lives separately at `.local/native-earn-2.json`. Do not delete it to retry. It includes private signed payloads, every replacement, confirmed receipts, and exact return quotes.

- **RPC timeout / ambiguous send:** run status, then repeat the same stage command. It can rebroadcast the same signed bytes; it does not create a fresh nonce. For Fusion it waits for settlement or on-chain expiry before authorizing another order. A provider rejection alone is not treated as cancellation.
- **Pending transaction / expired quote:** use `native:reprice`. It checks for a mined winner first, then prepares a fresh same-purpose transaction at the same nonce. Return replacements obtain new quotes and recompute amounts. If the older transaction wins, its actual quote is retained. An expired return quote is never deliberately rebroadcast.
- **Unrecognized consumed nonce / unexpected balance change:** stop and reconcile the external activity. The CLI will not guess which operation spent funds or blindly re-sign.
- **Reverted transaction:** receipt and gas use remain recorded. Re-run the stage to obtain a new preflight; a fresh simulation must pass before another transaction can be sent.
- **Aurora `REFUNDED` / `FAILED`:** status reports `route_failed`, not completion. Inspect the provider route and any returned funds before recovery. Automatic re-routing of failed/refunded intents is not implemented.
- **Lock left after a killed process:** verify that no native command is running, then remove only `.local/native-earn-2.lock`. Automatic stale-lock reclamation is deliberately disabled to avoid concurrent writers. Keep the journal itself.

Very small Aurora native-input quotes can be rejected by the provider. The current planner stops before the USDC return in that case; it does not promise eligibility for every balance. A zero ETH balance alone never establishes Aurora credit.

## Verification boundary

The full CLI integration test exercises the actual runner, planner, private journal, signed local transactions, fresh nested fork simulation, deployed Fusion/vault contracts, and zero final ETH/USDC/shares. It intercepts signed Fusion submissions locally and mocks Fusion/Aurora status responses; only unsigned/unfunded quotes reach public services. It proves local execution and state transitions, **not public resolver admission or real confidential credit**.

Run `npm test` for unit/regression tests. Run `scripts/native-cli-lab.mjs` with the same dedicated fork setup as `NATIVE-GAS-VERIFICATION.md` (port 18564, parent block 26079549). The integration script uses a temporary journal and restores the fork; it does not touch the user's native journal. Results are in `fixtures/native-cli-integration.json`.

No mainnet transaction or signed order was submitted while implementing these commands.

Verification recorded for this integration: **74 unit/regression tests passed**; full CLI fork execution ended with zero ETH/USDC/shares/WETH and remained pending until both mocked Aurora statuses became successful. An unsigned live withdrawal preview succeeded at block **26,082,501**; see [native-live-preview.json](fixtures/native-live-preview.json). At that earlier checkpoint the wallet still held prior vault shares and the legacy native context refused a new deposit. The later `ethereum` profile explicitly binds the approved old-share baseline, as recorded in [MAINNET-TEST.md](MAINNET-TEST.md). The native journal was uncreated at the original integration checkpoint; subsequent mainnet journals are historical evidence and must not be inferred absent today.
