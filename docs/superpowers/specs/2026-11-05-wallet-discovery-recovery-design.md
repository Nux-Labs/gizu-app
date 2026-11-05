# Wallet discovery and recovery

User-approved scope: the recommendations in this chat, implemented and pushed on
`feat/wallet-discovery-recovery` based on latest `origin/main`, independently of
`feat/distribution-algorithm`. Addresses may be processed temporarily; Gizu must
not persist readable wallet addresses or a user-to-wallet catalogue.

## Architecture and constraints

- The native wallet owns secrets, derivation metadata, signing and encrypted local
  history. JavaScript receives only capability/status/progress and aggregate
  discoveries, never the seed, derived credentials, catalogue or address batches.
- Preserve all released legacy derivations. Discovery additionally recognizes the
  distribution-v1 investment domain `m/44'/60'/145'/{chain}'/{cycle*8+slot}`,
  slots 0..4, on chains 1 and 4663, without enabling distribution deposits here.
- Native catalogue and operation history use encrypted paginated persistence,
  migrate existing files without losing signed/uncertain operations, and stop
  treating the current 256-row limit as a lifetime allocation limit. Keep explicit
  bounded pages, input sizes, read budgets and active-operation admission limits.
- Backend backup storage contains opaque IDs, hashed bearer credentials,
  authenticated client ciphertext, monotonic revisions and storage timestamps.
  It must never have a recovery decryption key. No root seed is uploaded.
- Native recovery material uses independent HKDF/HMAC-derived domains from the
  existing random root entropy: locator, authentication and encryption. The old
  exported backup already recovers that entropy with the original passkey.
- Backup API under `/wallet-recovery/v1/:id`: GET returns current ciphertext and
  revision; PUT performs compare-and-swap with `expectedRevision`. Authorization
  is a native-derived 32-byte bearer token; IDs are native-derived opaque 32-byte
  hex strings. All endpoints use no-store, bounded bodies and safe errors. A
  missing object returns 404; a conflicting update returns 409; credentials are
  never stored plaintext or logged. Writes and revision checks are atomic in PG.
- Treat encrypted backup updates as versioned snapshots/pages. Retain prior
  versions within a defined bounded policy. Native ciphertext authenticates
  locator, version and revision. Detect tampering and known revision rollback;
  never claim a fresh device can prove freshness from a malicious server alone.
- Save/synchronize newly allocated cycle metadata before funding authorization.
  Preserve pending signed execution records before broadcasting. Fail closed for
  new funding when required recovery persistence fails; reconciliation and
  already-signed recovery remain available. Avoid prompting for a passkey on
  every metadata update; the seed stays native and use remains inside existing
  native unlock/signing authority.
- Restore an older backup, fetch/decrypt newer recovery metadata, merge monotonically
  without reusing indices, and keep uncertain activity blocked pending verified
  reconciliation. Never invent lost allocation weights or reconstruct signing
  authority from balance observations. Restore never auto-submits transactions.
- Fallback discovery is bounded, read-only, incremental and resumable. It checks
  supported tokens/vault shares/native funds and confidential accounts via their
  appropriate authenticated provider. Include legacy and distribution namespaces.
  Empty balances do not prove unused identities. Explicit scan bounds are visible;
  reaching a chosen bound is not proof no further wallets exist.
- Backend operation coordination must survive restarts and multiple instances:
  shared atomic, expiring idempotency/replay/binding state with opaque identifiers
  and commitments only. No readable addresses, transaction bodies or user mappings
  in coordination storage. Existing client-held recovery envelopes remain separate
  server-authenticated operation tokens, not client-private backup encryption.
- Logging is allowlisted: route templates, status, latency, safe error codes;
  exclude addresses, query values, bodies, bearer tokens, signed data and raw
  provider errors across success/failure paths. Public contract metadata/prices
  remain cacheable. Private responses use no-store.
- Capability-gate new native methods. iOS must remain explicit about unsupported
  recovery capabilities; do not claim native support from mocked JS paths.
- No main merge, deployment, database mutation on production or live financial
  transaction is authorized. Commit and push both requested feature branches.

## Public mobile boundary

Native exports `getWalletRecoveryStatus(walletId)`,
`syncWalletRecovery(walletId)`, `restoreWalletRecovery(walletId)`,
`discoverWallets(walletId, throughCycle)` and `cancelWalletDiscovery(walletId)`.
Status is `{version:1, phase, revision, synced, scannedThroughCycle,
scanTargetCycle, discoveredWallets, recoveryRequired, messageCode?}`.
Phases: `idle`, `syncing`, `restoring`, `discovering`, `paused`, `ready`, `error`.
No address, encrypted file, bearer credential, locator or seed crosses this boundary.
`throughCycle` is an inclusive explicit integer bound, not a gap-limit completion
claim. Native enforces validation and owns cancellation/progress persistence.
Expose this in the existing Account wallet backup area with clear sync, restore
and scan actions, capability/error/loading handling and separate backup-file copy.

## Acceptance

Tests must prove migration and pagination beyond 256 entries; unchanged legacy
keys; distribution slot discovery; ciphertext/key-domain/tamper/rollback safety;
conflicting updates; older-backup merge; crash-safe signed work; no transaction
submission from discovery; cancellation/restart scan cursors; backend replica
idempotency and unavailable-store fail-closed behavior; address-free database/log
outputs; and real mobile recovery UI behavior. Run affected checks plus backend
and mobile suites, Rust tests, native unit tests/compilation, and independent review.
