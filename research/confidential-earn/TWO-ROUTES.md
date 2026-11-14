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

# Two mainnet test routes

Run from `research/confidential-earn` with Node >=22, installed dependencies, and Anvil (`ANVIL_PATH`). These commands send real funds when explicitly invoked. Previews only read providers and execute temporary local forks.

| Command profile          | Destination / vault                                                                  | Gas payment                                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `npm run ethereum -- …`  | Ethereum USDC / Pendle Ecosystem USDC `0x55C1B6e461a6334B567bAF0FEb5D728715446f05`   | Fusion buys native ETH as needed; native transactions afterward |
| `npm run robinhood -- …` | Robinhood (4663) USDG / Steakhouse USDG `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` | Pimlico ERC-20 paymaster + Pimlico bundler; charges USDG        |

Both start from **Monad USDC**, use advanced confidential routing, and split the confirmed confidential USDC input **10/90** before route fees. Wallet 1 keeps its payout; **only wallet 2 invests**. “Ethereum” here means Ethereum USDC, not converting the entire payout into ETH.

Candide's public endpoint rejected Monad 143 and Robinhood 4663 during the read-only checks. There is no verified usable Candide configuration for these routes, so they use Pimlico. Ethereum destination transactions need no bundler after the Fusion bootstrap.

The September recovery was recorded complete: [RECOVERY.md](RECOVERY.md) records both confirmed bridge receipts. The recorded saved test budgets were **7.652756 USDC Ethereum / 3.279753 USDC Robinhood**, from a total of 10.932509 USDC. Ethereum now records the old share balance and withdraws the full position after the new deposit; see the current mainnet test record below.

## Configuration and state

Existing `.env` settings remain in place. Ethereum uses `DEST1_ADD/PK` and `DEST2_ADD/PK`. Both profiles use the same `DEST1_ADD/PK` and `DEST2_ADD/PK`, as requested. Separate Robinhood destination variables are no longer used. `ROBINHOOD_RPC_URL` is optional (defaults to the public mainnet RPC). Both use existing Monad `SOURCE_ADD/PK`, `AURORA_API_KEY`, and `PIMLICO_API_KEY`; Ethereum also needs `ONEINCH_API_KEY`.

Both `prepare` and `fund` check the vault underlying. Ethereum records wallet 2’s starting shares in `initialVaultShares`, rechecks that exact balance before funding and deposit, simulates redemption of old plus newly minted shares, and withdraws the full position. This was explicitly approved for the existing 0.133013839453606864 shares. Robinhood continues to require zero starting vault shares. Robinhood requires zero ETH when starting a deposit; this cycle does not need native funds. Unsolicited ETH afterward does not block withdrawal, and its value is included in the return residual gate.

New profiles store routing, confidential keys, and earn journals under `.local/ethereum/` and `.local/robinhood/`. They **do not adopt the legacy `.local/state.json` or `.local/native-earn-2.json`**. Do not delete journals to retry. Each profile creates a separate confidential account. No new helper, shared application fee address, wallet-to-wallet transfer, or joint destination transaction is introduced. These controls do not promise protection against every amount/timing correlation.

## Fund and route (run once per profile)

Use `ethereum` below for the first test, then repeat the sequence with `robinhood` for the second. Complete/reconcile the source funding operation before starting the other profile. After recovery, run `npm run ethereum -- allocate` once. It freezes the current Monad USDC balance into **70% Ethereum / 30% Robinhood**, including each route’s source gas budget. Both percentages use that same original snapshot. Repeating `allocate` displays the existing allocation; it does not repartition the remainder. Each resulting budget retains the 10 USDC safety cap.

```sh
npm run ethereum -- check
npm run ethereum -- allocate     # once, after recovery; reserves BOTH test budgets
npm run ethereum -- init
npm run ethereum -- prepare      # quotes only; inspect the amounts and deadlines
npm run ethereum -- fund         # sends the Monad funding operation
npm run ethereum -- status       # repeat until phase: credited
npm run ethereum -- plan         # fresh 10/90 payout quotes
npm run ethereum -- payout 1
npm run ethereum -- status       # repeat until payout 1: delivered
npm run ethereum -- payout 2
npm run ethereum -- status       # repeat until phase: destinations_delivered
```

Do not run the sequence as an unattended shell script: wait for each stated confirmation. `requote` refreshes an unsigned source quote. `rebroadcast` reuses a saved source operation; check `status` first. `payout-resubmit 1` or `2` reuses a saved payout intent after an ambiguous submission. Signed/expired payout recovery may require provider reconciliation; do not delete the saved intent and start another.

## Ethereum vault cycle

```sh
npm run ethereum -- preview 2 deposit
npm run ethereum -- deposit 2
npm run ethereum -- earn-status 2
# Repeat deposit/status until invested.

npm run ethereum -- preview 2 withdraw
npm run ethereum -- withdraw 2
npm run ethereum -- earn-status 2
# Repeat withdraw/status until withdrawn.

npm run ethereum -- preview 2 return
npm run ethereum -- return 2
npm run ethereum -- earn-status 2
# Repeat return/status until awaiting_aurora; then status until complete.
```

Each execution invocation submits at most one native transaction or Fusion order. Recovery, native fee replacement (`reprice 2`), resolver settlement, and the final separate ETH return are explained in [NATIVE-CLI.md](NATIVE-CLI.md). Use the profile commands above to keep state in the new route directory.

## Robinhood vault cycle

```sh
npm run robinhood -- preview 2 deposit
npm run robinhood -- deposit 2
npm run robinhood -- earn-status 2   # repeat until invested

npm run robinhood -- preview 2 withdraw
npm run robinhood -- withdraw 2
npm run robinhood -- earn-status 2   # repeat until withdrawn

npm run robinhood -- preview 2 return
npm run robinhood -- return 2
npm run robinhood -- earn-status 2   # repeat until complete
```

Each Robinhood stage sends one atomic UserOperation for wallet 2. Approvals and vault calls use Morpho's established public router. Status waits for two further blocks and verifies the actual vault/transfer events. A successful Aurora funding transaction remains `awaiting_aurora` until Aurora reports `SUCCESS`.

After an ambiguous submission, use status first. `resubmit 2` sends exactly the saved operation. `reprice 2` prepares a same-nonce replacement with a fresh quote and at least a 12.5% fee bump; both hashes remain tracked, including the older route if it wins. Mined failures preserve evidence and restore the prior stage for a freshly checked retry. External nonce changes require reconciliation. Aurora failure/refund is reported as `route_failed`, not completion; automatic re-routing is not implemented.

## Dynamic reserves and acceptance

| Stage            | Ethereum                                                                                                                                 | Robinhood                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Before deposit   | Simulated deposit gas +10%; simulated withdrawal gas +30% at 2× current fee cap. Fusion uses minimum native output to size the purchase. | Current provider deposit cap + **2.6×** the provider's withdrawal cap, estimated against the simulated post-deposit vault state. |
| After deposit    | Temporary **0.05 USDC**, plus calculated ETH withdrawal reserve.                                                                         | Calculated USDG withdrawal reserve plus unspent deposit allowance. No fixed-dollar reserve.                                      |
| Withdrawal       | Fresh simulation and funding check.                                                                                                      | Fresh real-state provider estimate; liquid USDG must cover the entire current cap.                                               |
| Return           | Fresh Aurora USDC quote, then separate native-ETH quote and exact-cost Ethereum sweep.                                                   | Fresh Aurora USDG quote; transfer balance minus the full current paymaster cap.                                                  |
| Final acceptance | No shares; both Aurora routes successful; combined ETH+USDC **<0.5 USDC**. Local exact-sweep target is zero.                             | No shares; Aurora successful; combined ETH+USDG **<0.5 USDC**, target **<0.1**.                                                  |

Robinhood's return preview requires the full remaining allowance to be below 0.5 USDC in value. It uses current provider fees and gas limits; it never lowers the bid to force this threshold. If the current estimate cannot satisfy it, return stops and needs a later quote. The paymaster's actual charge reduces that allowance further. Final status checks the actual remainder at fresh prices.

Robinhood starts from Pimlico's current standard fee recommendation with 10% bid headroom, then keeps 5% token-budget headroom for quote changes during preparation. The signed provider cap must fit that budget; a larger change still stops before submission. These are percentage margins on fresh estimates, not fixed USDG charges.

All reserves are computed again for each action. The withdrawal stress budget does not guarantee arbitrary future fee increases, vault liquidity, or provider availability. Mainnet signed sponsorship/admission and resolver/intent settlement remain external dependencies even after local execution passes.

## Reproduce local verification

```sh
npm test
npm run test:robinhood-fork
npm run test:robinhood-replay
node --env-file=.env scripts/robinhood-authorization-lab.mjs
```

The Robinhood lifecycle lab creates synthetic accounts and temporary journals. It forks deployed USDG, vault, router, EntryPoint and paymaster bytecode, uses public unsigned Pimlico estimates, and signs/submits operations only to loopback. It changes only the fork's paymaster signer mapping. Aurora quotes and success statuses are mocked. Because public estimation cannot see locally consumed nonces, those estimates use the synthetic wallet's public nonce zero; signed local execution uses sequential nonces. This test proves local execution and accounting, not public signed sponsorship, bundler admission, Arbitrum sequencer fee settlement, or real confidential credit.

The lifecycle starts with installed delegation. The separate authorization lab tests the production `authorize()` method on a fresh synthetic wallet and includes a real type-4 transaction on the local fork, leaving that wallet with zero ETH. Public bundler attachment of that authorization remains untested.

Ethereum's existing integration evidence is [native-cli-integration.json](fixtures/native-cli-integration.json): zero final ETH, USDC, shares and WETH. Its Fusion submissions and Aurora statuses are also mocked. The regression suite additionally checks that the new Ethereum profile passes the route-specific journal directory instead of using the legacy journal.

The capture writes `fixtures/robinhood-cycle-operations.json` with synthetic signed operations (no private keys). `test:robinhood-replay` replays those exact payloads at the captured block, timestamps and base fees, without fresh provider quotes. It asserts identical UserOperation gas usage and final balances. These signatures authorize only the synthetic fork setup and must never be submitted publicly.

## Recorded results (29 September 2026)

**Both mainnet cycles completed.** Robinhood deposited and redeemed 2.521136 USDG, credited 2.636109 confidential USDC, and left **0.044207 USDG / zero ETH / zero shares**. Ethereum's later Fusion order filled; it deposited 1.084570 USDC, redeemed all old/new shares, credited 3.081997 confidential USDC through USDC and ETH returns, and left **zero ETH / USDC / WETH / shares**. Earlier expired orders are historical. Preserve the completed journals; do not repeat funding or payouts. See [mainnet results](MAINNET-TEST.md) and the [app integration handover](APP-INTEGRATION-HANDOVER.md).

- Unit/regression suite at the original local checkpoint: **103 passed**; the later pre-completion suite recorded **118 passed** in [mainnet results](MAINNET-TEST.md).
- Robinhood lifecycle, fork block **75,777,651**, synthetic starting balance **10 USDG / zero ETH**: **9.807085 USDG** invested; **0.163288 USDG** liquid afterward; full redemption left **9.959578 USDG**; Aurora funding transferred **9.931601 USDG**; final remainder **0.025111 USDG / zero ETH / zero shares**. Mock valuation was 1 USDG = 1 USDC. These are measured local results, not fixed live fees.
- Separate fresh-wallet authorization: passed at fork block **75,775,406** with zero destination ETH.
- Exact replay: **passed**, all three operations reproduced identical UserOperation gas usage and final balances; see [replay evidence](fixtures/robinhood-replay.json).
- Evidence: [cycle](fixtures/robinhood-cycle.json), [captured operations](fixtures/robinhood-cycle-operations.json), [authorization](fixtures/robinhood-authorization.json).

Those original verification runs sent no mainnet transactions. The subsequently authorized mainnet test is recorded in [MAINNET-TEST.md](MAINNET-TEST.md). Both routes use the existing shared destination credentials in `.env`.

Existing-share verification: `node --env-file=.env scripts/native-existing-shares-lab.mjs` exercises the production Ethereum native CLI on a current fork, with synthetic funding and the real old shares. [Evidence](fixtures/native-existing-shares.json) records a 6 USDC deposit/full-redemption test ending at 6.134158 USDC and zero shares. `--preview` with `FORK_USDC_ATOMS` obtains unsigned Fusion terms for a prospective payout; it sends no public transaction.

If Aurora stops offering a fresh return quote, an earlier accepted, unexpired, unfunded quote can be provided with `ROBINHOOD_RETURN_QUOTE_FILE` for both `preview 2 return` and `return 2`. File format: `{ "http": 200, "response": <Aurora quote response> }`. The amount must leave enough for fresh paymaster estimates and satisfy the existing residual cap. Recipient, refund address, assets, confidentiality, amount, and the earlier swap/address deadline remain validated. Completed/funded quotes must never be reused.
