# Native exact transfers and operation recovery

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Reviewed against source on 2026-11-14; this is not a new device, provider or security
verification. See [dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

## Exact transfers and operation recovery

The non-exported `TransferActivity` owns preparation, complete native review and a
fresh verified passkey assertion. Its challenge binds wallet, operation ID, revision
and review digest. JavaScript supplies proposals and receives public status only.
Android approval requires scrolling through the review; iOS places approval after all review content. Cancellation, screen lock,
unexpected backgrounding and the two-minute ceremony deadline end authority.

The adapted Rust policy permits Monad testnet (10143) EIP-1559 native MON transfers
only: account indices 0–15, up to 32 steps, at most 0.1 MON per step, 1 MON total and
0.1 MON maximum total fees. Only 21,000-gas EOA transfers are allowed; calldata,
contract recipients/senders and mainnet are rejected. Account 0 remains the app account.

`OperationJournal` encrypts JSON using AES-GCM and the local Keystore key, with AAD
binding format, wallet and journal generation. Atomic writes in `noBackupFilesDir`
persist signed bytes, hash, nonce, quote and step state **before any broadcast**.
Raw signed bytes and preparation quotes never cross Expo. Reads are bounded to
4 MiB and 256 active operations. Writes explicitly sync the temporary file, close it,
rename it, sync the parent directory and verify committed bytes. Any failure prevents
broadcast; a failure after rename retains the possibly committed record for reconciliation.
Legacy AtomicFile backups remain readable.

Before creating another operation, unsigned cancelled records are removed. At capacity
(256 entries or 3 MiB, reserving 1 MiB for new signed records),
the oldest settled operation is durably archived in a separate encrypted, generation-scoped
file before removing its active entry. Archive failure leaves the active journal intact;
a crash between writes may leave a harmless duplicate. Unresolved signed operations
are never compacted. Activity displays the active window; archive files are retained
locally for later diagnostics, are not currently browsable in the app, and are not
included in wallet backups. Archives can accumulate; storage failures fail closed.

Refresh and reopening only reconcile receipts, canonical finalized blocks and
sender nonces. They never sign, rebroadcast or continue a batch. A missing transaction
with an unchanged nonce can be explicitly retried after fresh native review and
passkey authorization, using identical saved bytes and fees. Pending or conflicting
nonces block further execution. There is no automatic fee replacement or conflict
resolution. RPC failures preserve evidence and require another successful refresh.

Unsigned remainder is newly prepared and reviewed on every resume. Revision checks
reject stale requests. Execution waits for each step to finalize before proceeding;
a pending result stops the batch. Cancellation prevents unsigned remaining steps but
cannot revoke a signed transaction; its status and explicit retry remain available.
Entropy-file restore creates a fresh journal generation and alone cannot resume
another installation's operations. Android's separately authenticated recovery sync
can import exact signed history into that generation and reconcile read-only;
explicit resume retains its normal approval rules. iOS does not advertise recovery
sync. Activity shows saved outgoing records, not indexed incoming history.

Android RPC uses OkHttp 4.9.2, matching the existing React Native dependency. The
fixed Monad endpoint and bounded, cancellable transport live in `rpc/`; orchestration,
reconciliation, journal and native approval live in `transfers/`. The inactive module
is not a runtime dependency. Guided phone checks were user-reported successful; extended failure-path
acceptance remains pending. See [verification evidence](NATIVE_SIGNER_VERIFICATION.md).
