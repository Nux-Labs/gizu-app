# Swap persistence and recovery boundaries

**Complexity:** 3. **Status:** implemented reference. **Source review:** 2026-11-14.
Companion to [Swap architecture](SWAP_ARCHITECTURE.md). Limits below describe the
inspected files, not a new cross-platform storage guarantee.

## State ownership

| State                                        | Owner / lifetime                                                      | Recovery meaning                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Input, loading and displayed status          | React Native memory                                                   | Recreated from native public reads; not authoritative execution state                       |
| Entropy, keys and current approval authority | Native wallet/core memory and protected wallet storage as appropriate | A serialized swap does not restore unlocked signing authority                               |
| Core machine                                 | Rust, exported into native encrypted storage                          | Plan, step, request IDs, quotes, signed payloads, progress and deadlines needed to continue |
| Account allocation registry                  | Native wallet record with shared allocation rules                     | Persist before using recipient indices; do not reuse an abandoned allocation by guessing    |
| Active swap envelope                         | Platform store, scoped to wallet and journal generation               | Exact saved execution evidence; not a general public history                                |
| Android funding batch/reservations           | Android native batch and reservation stores                           | Tracks source children, committed work and reserved balances across Swap/Earn               |
| Tracked tokens and public summaries          | Separate platform portfolio store                                     | Supports holdings discovery and completed/cancelled history after active-state replacement  |
| Provider/RPC state                           | External services and chains                                          | Needed to resolve uncertain submission and verify actual delivery                           |
| Wallet backup                                | Separate native backup system                                         | Wallet recovery is not restoration of an installation's live swap journal                   |

## Encrypted envelopes and platform differences

Both active stores use `gizu-swap-<journalId>.enc` and authenticated context binding
`gizu-swap:v1:<walletId>:<journalId>`. They require the existing local encryption key.
Missing keys or invalid envelopes are errors, not an instruction to create a new wallet.

| Detail                  | Android                                                                                        | iOS                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Envelope                | Version, wallet/operation IDs, funding address, core state, history and optional funding batch | Version, wallet/operation IDs, funding address and core state    |
| Core state string bound | 67,108,864 UTF-16 code units (`String.length`)                                                 | 67,108,864 UTF-8 bytes                                           |
| File read/size bound    | 268,435,456 bytes                                                                              | 268,435,456 bytes; save checks clear envelope size plus 32 bytes |
| Extra orchestration     | Child source operations, reservations and combined review scope                                | Single active core operation in inspected wrapper                |

See [Android store](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/swap/SwapStore.kt)
and [iOS store](../../mobile/modules/gizu-stored-signer/ios/Swap/SwapStore.swift).
They delegate file writes to platform wallet-file helpers; encryption and durable
write behavior must be reviewed together when changing storage.

The active journal contains signed payloads even though it excludes seed material.
Never log/export it as if it were harmless status JSON. Public summaries exclude
those payloads and cannot replace execution evidence.

## Ordering at side-effect boundaries

1. Persist recipient allocation before creating an operation that uses it.
2. Drive `next_step`; it can prepare signed material inside the native core.
3. Persist exported state **before** performing the resulting network request.
4. Return the matching request ID, response status and body to the core.
5. Persist the resulting state before advancing again.
6. Save independently rebuildable portfolio summaries after recoverable execution
   state. A summary failure must not erase the authoritative journal.

Android also records source reservation/batch transitions. Its persist path saves
signatures before marking shared source reservations signed. Combined approval
scope is held in memory, not recovered as reusable authority from the batch file.

These steps reduce lost-submission ambiguity; they do not make the chain, provider
and local filesystem one atomic transaction. A crash after submission but before
recording its response must remain recoverable as an uncertain outcome.

## Recovery by interruption point

| Interruption                              | Preserved evidence                                                | Required behavior                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Before approval                           | Unsigned plan/quotes and allocated indices                        | Revalidate/review; do not assume allocation can be reused elsewhere                       |
| After signing, before known submit result | Signed request and saved step                                     | Inspect receipt/status; never construct a duplicate simply because the response was lost  |
| During source credit wait                 | Funding quote/submission evidence                                 | Check route credit separately from source receipt                                         |
| Some payouts/orders completed             | Per-leg state, signatures and private-sale inbound-credit records | Reconcile individual legs and operation-bound credits; do not restart the whole operation |
| App process ended                         | Encrypted machine, without live seed                              | Restore state; fresh unlock is required when signing needs authority                      |
| User cancelled                            | Cancelled state and previous submissions                          | Stop future signatures; cancellation does not revoke prior transactions                   |
| Operation expired                         | Saved plan and financial evidence                                 | Reconcile then use a supported recovery path; retry does not extend lifetime              |
| Wallet restored on another installation   | Recovered wallet/registry subject to backup contents              | New local journal generation; do not claim old in-flight execution history was restored   |

Core `restore` imports state with `seed: None`. A matching wallet unlock can restore
in-memory authority within policy, but cannot change the plan's 24-hour lifetime.
The normal signing session is 15 minutes. New terms outside limits trigger review.

Transient submit failures redirect to status/receipt handling. Certain paths allow
bounded retries of saved submissions after polling. Consequently Resume is an
execution action, not a guaranteed read-only query. UI status refresh is also not
proof that provider reconciliation occurred. See [failure handling](../internal/SWAP_FAILURES.md).

## Holdings, history and partial recovery

The portfolio store tracks token contracts and completed/cancelled summaries
independently of the active operation. Its encryption context also binds wallet
and journal generation. A successful balance read is evidence of holdings, not a
reconstruction of every historical trade or its approved terms. Summaries preserve
`completionTarget` and `privateCreditedAtoms`; private sales must not be rendered
as a public Monad return. The saved core contains each sale inbound's Aurora quote,
verified Fusion transaction hashes and authenticated credit, so restart can reconcile
private completion without allocating public recipients or signing a replacement sale.

[Shared holdings policy](../../mobile/modules/gizu-stored-signer/core/src/swap_holdings.rs)
selects allocated accounts, full-token holder sets and legacy sell batches. An unfinished operation should be
preserved instead of overwritten. The temporary unfinished-buy recovery scans a
bounded recent allocation range (up to 60 recipients) for USDG; it is not an
unlimited indexer and cannot prove that no funds exist outside that range.

Backup format evolution is separate from swap-state versioning. Inspect current
backup codecs for exactly which registry metadata is restored. Neither backup
success nor identical derived addresses guarantees reconstruction of a lost
provider quote, signed order, active journal or local history.

## Backend and external recovery limits

The inspected `/v1/swap` gateway is an adapter layer, not the durable owner of the
mobile operation. Its Aurora token cache is disposable. Do not assume a backend
database can recreate the phone's journal, or import Earn's separate recovery-key
semantics into Swap. Provider status and chain receipts remain necessary external
evidence, with their own availability and retention limits.

## Tests required when changing these boundaries

- Persistence failure before submission prevents the external request.
- Crash/lost response after submission reconciles the saved request without a new signature.
- Corrupt envelope, wrong wallet/generation or missing local key fails closed.
- Summary-write failure retains the active execution record.
- Partial Android batch completion preserves child records and reservations.
- Process restart restores no reusable approval authority; stale responses cannot advance cancelled work.
- Changed quote requires appropriate review; expiry cannot be extended by retry.
- Full-holding private sales preserve frozen holders and verified per-inbound credits,
  including large/partial holder sets, without allocating public recipients.
- Legacy public-return plans retain their original completion behavior and history fields.
- Wallet restore/holdings discovery does not fabricate transaction history.

This list is acceptance guidance for future changes, not a report that all listed
cases were executed during documentation work.
