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

# Residual verification — 29 September 2026

**Correction:** the whole-reserve threshold is an acceptance guard, **not a usable fee solution**. Artificially lowering the bid to pass it can prevent inclusion. The known bad plans are blocked. There is **no demonstrated solution at the observed mainnet fees**. No live destination transaction was submitted or funded during this work. The residual requirement is strictly **<0.5 USDC**, preferably **<0.1 USDC**.

The conditional path keeps Simple7702Account, Circle, and Morpho's existing SDK contracts. It bounds the _whole amount outside the deposit_, rather than predicting how much Circle will refund. It requires a much cheaper gas market. The public Candide deployment's configuration is unknown; successful local Voltaire admission is not a promise of public-relay acceptance.

## Why the previous conclusion was inconsistent

`REFUND-SOLUTION.md` still opened with a second Circle deposit as a usable path after that proposal was explicitly rejected and the handover recorded the rejection. The prior task transcript places the recommendation at 01:06 UTC, rejection at 01:09, and handover update at 01:11 on September 29. The old opening was not updated. It now labels the proposal rejected and the estimates historical.

The underlying acceptance mistake was broader than documentation:

- A successful `handleOps` call proved execution, not relay admission or the final residual requirement.
- A lower gas-price bid addressed one cause of excess reserve. It did not fix oversized gas limits. Pimlico's admission floor was also higher than that bid.
- Candide accepted only after its verification-gas requirement was met; the resulting deposit still missed the residual target.
- The runner marked a reconciled successful deposit `complete` even when its recorded residual exceeded the target. It now reports `residual_exceeded`, including when loading old completed records with a known excessive balance.

Circle's permit authorizes the maximum pull. The deployed paymaster pulls during validation, then refunds after wallet execution. The deposit cannot invest that later refund. Its permit deadline is hardcoded to `uint256.max`; a caller-specified short permit lifetime was not a usable fix either. See [verified Circle implementation](https://eth.blockscout.com/address/0xdC57D57552256Df09FFEBED067bAA06eE49415f1?tab=contract).

## Historical reproduction

The fixtures contain public transaction input, authorization, receipt, block header, and prior transaction hashes. `scripts/replay-historical.mjs` uses the original signed UserOperation, Circle permit, and EIP-7702 authorization. The outer bundler is impersonated locally. No private key is needed for these two replays.

| Replayed case   | Deposit USDC | Circle charge USDC | Residual USDC | UserOperation gas | Transaction gas |
| --------------- | -----------: | -----------------: | ------------: | ----------------: | --------------: |
| First deposit   |     1.128419 |           2.063812 |      2.464035 |           672,955 |         496,687 |
| Candide deposit |     0.134142 |           1.726651 |      1.731762 |           650,510 |         496,879 |

Both replays assert the original charge, residual, deposit, minted shares, UserOperation gas, and transaction gas. Both fail the residual acceptance criterion. Results: [first](fixtures/first-replay-result.json), [Candide](fixtures/candide-replay-result.json).

**The first transaction required same-block context.** An earlier [vault reallocation at transaction index 216](https://eth.blockscout.com/tx/0x4a30e4cf0742403d799a1c9cf80e85f1eb94cd9b826dc1c8e0b013859476ad64) changed the same vault before our deposit at index 259. Replaying the deposit directly from its parent block initially consumed 398,281 wallet-call gas instead of 351,333, and charged 2.189137 USDC instead of 2.063812. Replaying that original reallocation first in the same block reproduced all the above metrics exactly. The 46,948-gas cheaper call increased the refund. This is a concrete reason a single parent-block gas estimate is insufficient.

Scope: these are exact financial/gas reproductions for the relevant execution path, **not full replays of every unrelated transaction in each block**. The first replay includes the relevant prefix transaction; the Candide replay matches from parent-block state without another prefix transaction. The counterfactuals below deliberately change specified inputs; they are not historical mainnet outcomes.

## The acceptance guard and its liveness limit

For a successful deposit, with starting balance `B`, deposited amount `D`, and nonnegative actual Circle charge `C`:

```
final USDC = B - D - C <= B - D
```

Require **`B - D < 500,000 atoms` before signing or submitting**. Prefer `B - D < 100,000` when possible. The current planner sets `D = B - maximumHold`, so the maximum hold itself must fit below the threshold. A nearly full refund then still fits the threshold. Neither observed gas use nor a guessed minimum final charge is needed for this bound.

Implemented in `src/residual-policy.mjs`, with enforcement in `signVaultDeposit` and `submitVaultDeposit`. Therefore fresh send, reprice, and resubmit paths share the check. Old saved operations lacking the bound metadata cannot be resubmitted. The signer also re-reads USDC before signing; a changed balance stops it. Preview reports the bound separately from the fee-floor check. No gas-limit tightening or artificially cheap production bid was added. The existing live next-block bid and Pimlico floor checks remain.

**Limits:** the arithmetic assumes successful execution and no incoming USDC after the checked starting balance. It is not an on-chain assertion against unsolicited transfers. Reconciliation checks the actual residual and never marks a failed or excessive-residual deposit complete. A reverted wallet call can still cost gas; the negative test below explicitly demonstrates that. Provider admission, state changes, slippage, and sufficiently safe gas allowances must still be checked independently. This is not a universal, immediate-deposit guarantee.

## Counterfactual execution matrix

`residual-fork-lab.mjs` uses the historical states, original SDK share-price bounds/deadlines, and Morpho SDK 6.0.0's pure calldata builder. It changes the amount, associated signatures, stated gas fees/limits, and sets destination ETH to zero. The first-deposit cases include the real preceding reallocation and original delegation authorization. Test signatures use historical nonces already consumed on mainnet and are retained only in ignored `.local/` files.

| Scenario                                                            | Maximum hold | Final Circle charge |   Final USDC | Outcome                                                   |
| ------------------------------------------------------------------- | -----------: | ------------------: | -----------: | --------------------------------------------------------- |
| Candide state, 410k call / 125k Circle validation, historical fees  |     2.118172 |            1.604064 | **0.514108** | Deposit works; acceptance fails                           |
| First state, 410k call / 140k Circle validation, historical fees    |     2.977802 |            1.916694 | **1.061108** | Deposit works; acceptance fails                           |
| Candide state, original generous limits, 0.1-gwei cap/effective fee |     0.362797 |            0.181130 | **0.181667** | Passes <0.5                                               |
| First state, original limits/delegation, 0.1-gwei cap/effective fee |     0.350326 |            0.184536 | **0.165790** | Passes <0.5                                               |
| Candide state, 0.02-gwei cap/effective fee                          |     0.072560 |            0.036226 | **0.036334** | Passes <0.1                                               |
| Candide state, 0.1-gwei cap but effective fee falls to 1 wei        |     0.362797 |            0.000001 | **0.362796** | Passes even with almost full refund                       |
| Candide state, deliberately insufficient 100k call gas              |     0.158990 |            0.093804 | **3.498751** | Wallet call fails; no deposit or shares; never acceptance |

Every successful case asserts exact USDC accounting, minted shares owned by wallet 2, zero destination ETH before/after, one UserOperation, and no reference to wallet 1 in calldata or receipt logs. No new helper, shared application fee recipient, or wallet-to-wallet transfer is added. Wallet 1 remains outside the deposit flow. These checks establish the absence of the prohibited new mechanisms, not a claim of complete anonymity against timing, amounts, or service-provider observation.

Full configuration/result data: [residual-fork-results.json](fixtures/residual-fork-results.json).

## Local bundler admission and inclusion

The test uses Candide's published Voltaire Docker image pinned to:

```
ghcr.io/candidelabs/voltaire/voltaire-bundler@sha256:ba8a23fbaae9bed49a671152c3ec404fcd5a8debd86fdfa5e8138279a71da26d
```

The final test enables normal fee tolerance and validation; it does **not** use `--unsafe` or disable the fee check. A local RPC fixture supplies an explicit 0.08-gwei base-fee block and a 0.02-gwei priority recommendation. This avoids mistaking Anvil's synthetic fee recommendations for an Ethereum market quote. All execution RPC traffic terminates at the local Anvil fork. P2P and automatic bundling are disabled. A separate, unfunded test identity receives ETH only on the local fork to act as bundler. The startup check for all EntryPoint versions is skipped because this test concerns deployed v0.8, not unrelated versions.

The test rejects an underpriced 0.02-gwei operation in that 0.1-gwei market, checks the inadequate verification-gas case, admits the properly configured operation, and explicitly triggers its local inclusion. It reconciles the receipt and wallet balances. The included operation deposits **3.229758 USDC**, pays **0.181130 USDC**, and leaves **0.181667 USDC**, with zero destination ETH. See [local-bundler-execution.json](fixtures/local-bundler-execution.json) for the actual errors, UserOperation hash, and local receipt hash.

**This is a pinned local deployment of the published bundler, not a reproduction of undisclosed Candide production settings.** A public endpoint can impose a different floor or policy and refuse the same operation. That would prevent liveness; it does not invalidate the balance bound on a successful deposit with the stated starting balance. No new signed destination operation was submitted to a public bundler.

An initial diagnostic against Anvil's unadjusted recommendation correctly rejected even the historical operation at a 1.577939683-gwei floor; this was a fixture mismatch, not a new mainnet observation. Another diagnostic disabled that fee check to isolate validation; it is not used as the final admission proof. Receipt and nonce caches survive `debug_bundler_clearState`, so **restart Voltaire between repeat test runs**. The harness rejects a stale cached receipt rather than accepting it as a new result.

## Eligibility at the September checkpoint and other candidates

The public read at **block 26,080,059, 02:13:20 UTC** confirmed wallet 2 still has **1.731762 USDC**, **0.133013839453606864 shares**, and **0.000707811898201088 ETH**. No balance was spent during this investigation.

Using the historical Candide gas limits and that read's Circle price:

- The strict 0.5-USDC whole-reserve bound needs a maximum fee no higher than **0.139001625 gwei**.
- The preferred strict 0.1-USDC bound needs no higher than **0.027800102 gwei**.
- Observed Ethereum base fee was **0.569372879 gwei**.
- Pimlico's public slow quote required **1.811443141 gwei maximum**, with **1.029970521 gwei priority**.

These are diagnostic thresholds for that gas profile, not a fresh ready-to-send operation. **The observed market cannot pass the conservative bound.** Do not force a low bid or remove relay checks to make the preview look acceptable. [Read-only snapshot](fixtures/live-read-only-state.json); `scripts/read-acceptance-state.mjs` refreshes it without secrets or signatures.

Other research did not establish a usable replacement:

- **Candide token paymaster:** its contract charges in `postOp`, but its public sponsorship service also enforces a retained reserve. Unsigned probes rejected 1.1 USDC retained with a roughly 1.12-USDC required amount. A 1.3-USDC reserve and 470k call gas obtained paymaster data at a 0.6-gwei bid; that was below the then-current base fee and was not admission or inclusion proof. It is not the solution. [Verified contract](https://eth.blockscout.com/address/0xa8151918eac3818deb713d3dbbb7930329fe86ed?tab=contract).
- **Biconomy MEE:** its quote/payment structure initially looked like fixed-fee settlement, but current documentation and published SDK explicitly refund unused gas in ETH. It cannot be called a dust fix just by changing the residual's denomination. Unfunded test-account quote probes also hit the service's actual fee-balance checks despite simulation token overrides. No destination authorization or execution signature was sent to Biconomy. [Fee-token schema](https://docs.biconomy.io/supertransaction-api/openapi.yaml), [7702 quote flow](https://docs.biconomy.io/overview/supertransaction-api/quote-7702).
- **Pimlico constantFee:** it adds a constant to variable actual gas; it does not replace the charge with a caller-chosen fixed total. [Paymaster source](https://github.com/pimlicolabs/singleton-paymaster/blob/master/src/SingletonPaymasterV7.sol).
- Another Circle cleanup deposit, a new helper, a shared application fee collector, wallet-to-wallet transfers, and bundling the two destinations remain excluded. Automatic conversion into ETH was not adopted during this earlier investigation. The user subsequently explicitly approved a Fusion-funded native ETH reserve; see [NATIVE-GAS-VERIFICATION.md](NATIVE-GAS-VERIFICATION.md).

## Reproduce

Prerequisites: Node >=22, this package's locked dependencies, Docker for the local bundler test, and **Anvil 1.8.3**. An archive RPC must serve the two historical states. Keep `.env` and `.local/` private. The fork tests read the existing `DEST2_PK` and `DEST1_ADD`; they never print keys. The public historical replay needs neither.

From `research/confidential-earn`, start two dedicated Anvil instances in separate terminals:

```sh
anvil --fork-url https://eth.drpc.org --fork-block-number 26075410 --port 18548 --host 127.0.0.1 --hardfork prague --order fifo --accounts 0 --gas-price 0 --compute-units-per-second 80 --timeout 120000
anvil --fork-url https://eth.drpc.org --fork-block-number 26079549 --port 18554 --host 127.0.0.1 --hardfork prague --order fifo --accounts 0 --gas-price 0 --compute-units-per-second 80 --timeout 120000
```

Run the execution tests sequentially; they snapshot/revert the local forks:

```sh
npm test
node scripts/replay-historical.mjs first
node scripts/replay-historical.mjs candide
node --env-file=.env scripts/residual-fork-lab.mjs
node scripts/create-bundler-test-key.mjs
```

Start the local fee fixture in another terminal:

```sh
node scripts/local-market-rpc.mjs
```

Start a **fresh** local bundler (Docker Desktop/macOS uses `host.docker.internal`; Linux needs the corresponding host gateway/network setup):

```sh
docker run --rm --platform linux/amd64 --name earn-voltaire-lab \
  -p 127.0.0.1:18560:3000 \
  ghcr.io/candidelabs/voltaire/voltaire-bundler@sha256:ba8a23fbaae9bed49a671152c3ec404fcd5a8debd86fdfa5e8138279a71da26d \
  --bundler_secret "$(cat .local/bundler-test-key)" \
  --rpc_url 0.0.0.0 --rpc_port 3000 \
  --ethereum_node_url http://host.docker.internal:18561 \
  --chain_id 1 --debug --disable_p2p --eip7702 --disable_entrypoints_code_check
```

Then run:

```sh
node --env-file=.env scripts/local-bundler-lab.mjs
```

Archive-rate errors or missing receipts invalidate the run; do not count them as passes. The test fixtures contain the exact block/transaction data, gas fields, assertions, and results. They still require historical state from an archive provider; this is not an entirely offline chain snapshot. All local scripts use fixed loopback execution endpoints. `probe-local-bundler.mjs` is only an optional diagnostic using the original, already-consumed public operation; its results are separate from the final end-to-end test.

The original verification suite contained **40 tests**, including strict boundary values, rejecting the two historical plans before signing/submission, refusing legacy payloads without residual metadata, detecting balance changes, and preserving the distinction between execution and acceptance. No test establishes a broadly usable solution at the observed market price.
