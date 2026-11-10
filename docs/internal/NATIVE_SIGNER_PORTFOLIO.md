# Native portfolio, holdings and swap recovery

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Extracted from the signer reference on 2026-10-08. This split preserves the
recorded implementation details; it is not a new device, provider or security
verification. See [dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

## Shared public Monad portfolio

`core/src/portfolio.rs` owns public account selection, bounded derivation, ABI
uint256 decoding and checked aggregation. Swift and Kotlin consume its generated
UniFFI bindings and serialize the same `MainnetPortfolioSnapshot` for Home.
Account 1 supplies `fundingAtoms`; `returnAtoms` includes account 0 and allocated
public recipients. Account 0 retains its existing `funding` row role for wire
compatibility. Account 2 and unallocated recipients are excluded. The registry's
`nextRecipient` cannot exceed 8192 (8191 included public accounts).

The shared core rejects invalid registry versions, unknown/duplicate accounts,
noncanonical decimal amounts, malformed ABI balances and uint256 sum overflow.
Unknown cached amounts stay absent and cannot produce a complete snapshot.
Android retains its encrypted incremental cache, history and additional assets.
Its partial/stale flags pass through without changing their meaning.

The iOS reader requires an existing backup-verified record, derives public accounts
in cancellable batches of 64 and releases the record before networking. It uses
`https://rpc.monad.xyz`, validates chain 143, pins every USDC call to the same
finalized canonical block hash, and rechecks the hash before returning. There are
at most four concurrent batches of 40 calls, a 15-second request timeout,
20-second resource timeout and the enclosing 120-second ceremony deadline.
Any missing/invalid observation fails the refresh; no partial result is labeled
complete. The previous Home snapshot remains visible with an error. Reading does
not invoke passkeys or grant signing authority. It may backfill public swap summaries
from the encrypted active journal; it does not change wallet keys or account allocation.

The JavaScript bridge serializes portfolio, holdings, funding-address and saved
swap-status reads through one queue. Opening Swap during a balance refresh waits
for that read to settle, including failure, before loading its address and status.
Locking invalidates pending reads; signing and cancellation actions are not queued
or automatically replayed.

`ios/Tests/Fixtures/public-portfolio.json` is consumed by Rust, Kotlin, Swift and
the Home validator tests. It includes account-0 funds, values above JavaScript's
safe integer range, zero balances and Android partial/stale observations. Run
`stored-signer:build` before Android unit tests: the latter load the host Rust
library via JNA as well as compiling Android's generated bindings.

The iOS portfolio includes persistent public swap summaries. Robinhood token
holdings use a separate read contract; Earn asset extensions remain Android-only.
The testnet transfer transport/policy remains separate.
See [GIZU-1](../feature-plans/GIZU-1_IOS_MONAD_PORTFOLIO.md) for verification and device acceptance.

## Shared swap holdings and iOS recovery

`core/src/swap_holdings.rs` owns allocated recipient selection, Earn-withdrawal
exclusions, exact ABI balance validation and checked uint256 totals. The Swap form and
holdings sale action use `<token>:all`: native selection includes every eligible allocated
recipient for that tracked token, including partial groups, and excludes Earn withdrawal
accounts. Legacy three-account batch IDs remain accepted for compatibility. Swift/Kotlin
perform RPC transport; neither accepts holder addresses chosen by JavaScript.

An all-wallet sale uses one persisted confidential operation. Balance discovery reads at
most 20 holders (40 RPC calls) per request and saves its cursor; empty token wallets are
removed before native review. One approval covers the funded wallets, and every sale's
verified private credit is reconciled before advancing. Restoring resumes the saved plan
rather than rebuilding it from current holdings. A fresh native unlock can resume an
approved private sale after a long interruption; each signing session still expires after
15 minutes. Buy and legacy public payout limits are unchanged. The JavaScript estimate
continues to use the full token balance and remains an estimate before provider fees.
Wallets below Fusion or bridge minimums are reported and left in place.

Multi-wallet journals allow up to 64 MiB of state and a bounded 256 MiB encrypted journal
file on both platforms; other iOS protected files keep their existing 4 MiB write limit.
These storage bounds are not device or live-provider capacity measurements. `ios/Tests/Fixtures/swap-holdings.json` runs through all three
languages, including amounts above JavaScript's safe-integer range.

The iOS `SwapHoldings` reader pins Robinhood chain 4663 reads to one latest block
number and rechecks its hash before returning (the network prunes older state).
Invalid metadata, missing balances, chain mismatch and reorgs fail the entire
refresh; errors never become zero holdings. A selected token becomes tracked only
after a successful read. Reads do not create or advance a swap.

`SwapPortfolioStore` stores tracked contracts and completed/cancelled public
summaries independently of the active encrypted swap journal. Its existing
non-synchronizing wallet key, wallet ID and journal-generation ID bind the file;
atomic writes include read-back verification. Corruption or missing keys fail
closed. Active state is persisted first so an interrupted summary write can be
backfilled. No raw signed payloads or secrets enter the public summary. Restore
starts a new local journal generation; token discovery requires the restored
account registry and selecting the token again. Overwritten legacy history
cannot be reconstructed from balances.

Selected-holding selling reserves fresh return accounts before starting the core
operation and cannot overwrite unfinished work. Explicit Resume calls core retry;
status reads only restore public state. Recovery preserves an incomplete operation
and otherwise uses the shared recovery plan's last-60-allocated-account limit.
Private-balance payout uses `confidentialPayout`, not a new source deposit.

Native review and passkeys remain mandatory at the core's review/unlock gates.
iOS swap ceremonies have a bounded 15-minute lifecycle, matching the displayed
swap approval; wallet/backup ceremonies retain two minutes. Backgrounding, lock
and Cancel invalidate the ceremony. Polling remains in the native dialog until
review, unlock, pause or completion; cancellation checks prevent a late network
response from advancing the operation. Closing cannot reverse a submitted step.
Simulator tests are not proof of funded execution or physical-iPhone passkeys;
those remain acceptance gates, including background/resume and restore discovery.
