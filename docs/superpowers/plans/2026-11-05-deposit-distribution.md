# Deposit distribution implementation plan

Approved spec: `docs/superpowers/specs/2026-11-05-deposit-distribution-design.md`.
Branch: `feat/distribution-algorithm`. Base: `7415714`.

## Global constraints

- New deposits distribute all verified confidential credit to one to five wallets;
  every selected wallet deposits into the same supported vault.
- Reuse the existing count/weight algorithm unchanged. Persist the native choice
  before quotes; retries and resume never choose again.
- Legacy missing distribution metadata keeps its exact two-wallet 10/90 policy.
- Preserve one bounded Robinhood approval and Ethereum's existing stage approvals.
- Preserve uncertain signed work and independently verified per-wallet receipts.
- No network transactions, deployment, merge or push during this task.

## Shared wire contract

- Saved cycle, intent and deposit snapshot gain optional
  `distribution: { version: 1, weightsBps: number[] }`. Positive integer weights
  total exactly 10,000; length is 1..5. Destinations for such records are ordered
  investment slots, each `{role: 'invest', slot, chainId, address}`.
- Distribution payout legs are `invest:0` through `invest:4`. Legacy `hold`,
  `invest`, and `withdrawal` stay unchanged. A distribution payout request/proposal
  includes the same `distribution` object. The leg identifies its slot.
- For slot j, compute cumulative allocated credit using floor(total * weight /
  10000), with the last slot receiving the remainder; this source's input is the
  difference between allocation at `(offset + credit)` and allocation at `offset`.
- Add native Rust export `derive_earn_distribution_addresses(entropy, chain_id,
  cycle_index, count)`. New investment keys use
  `m/44'/60'/145'/{chain_id}'/{cycle_index * 8 + slot}`. Count 1..5, slot 0..4,
  supported chains 1 and 4663, checked arithmetic. Legacy confidential key is
  unchanged. Shared private helper derives a selected distribution investment key.
- Vault, delegation and Ethereum liquidity proposals gain optional
  `investmentSlot` (0..4); present means the new distribution domain, absent means
  the legacy investment role. Only native persisted-cycle validation may attach it.
- Distribution deposit reviews use `sources[].allocations[]` in slot order
  (same fields as legacy hold/invest leg reviews) and `deposits[]` in slot order
  (same fields as legacy deposit review plus `slot`, `recipient`). Aggregate
  `deposit` minimum/estimate/fee/reserve totals may remain for display compatibility.
  New review fields and optional metadata must be explicitly allowlisted.
- Partial progress records per-slot payout/deposit state, assets/shares and tx hash;
  public snapshot gains `investments[]` with `slot`, `recipient`, `receivedAtoms`,
  `depositedAtoms`, `sharesAtoms`, `status`, optional `transactionHash`. Aggregate
  `depositTransactionHash` must not pretend multiple transactions are one.

## Task 1: Shared Rust authority and derivation

Owner scope: `mobile/modules/gizu-stored-signer/core/**` only.
Add tests first for distribution derivation, legacy stability, cumulative exact
allocation, malformed plans, slot identity binding, and all investment signers.
Implement the export and shared plan helper; extend payout, Ethereum vault,
sponsored/delegation and Ethereum liquidity proposal/authority paths. Native source
funding/read-auth remains on the existing confidential cycle identity. Keep
legacy serialization compatible. Run full `stored-signer:test -- --offline`.

## Task 2: Backend payout contracts

Owner scope: `backend/**` only.
Add tests first for distribution payout amount conservation, malformed weights,
slot mismatch, independent sibling idempotency and legacy behavior. Extend
payout prepare/submit/status/cancel/recovery-envelope schemas and fingerprints to
bind the saved distribution. Reuse native-only recipient requests and existing
credit evidence. Preview schemas admit distribution leg identities. Backend
vault planners remain address-based; native supplies the correct slot owner.
Run backend tests/typecheck/build.

## Task 3: Native Android integration

Owner scope: Android Kotlin/native module, Android tests, generated bindings only.
Add tests first. Persist new distribution metadata atomically with cycle/journey
identity before quotes, and preserve it in backup codecs. Extend existing native
deposit preparation, approval, journal, progress, remaining review and coordinator
to per-slot allocations/deposits. Legacy records keep old paths. Attach the exact
saved distribution to payouts and `investmentSlot` to owned vault/liquidity/
withdrawal proposals; never trust bridge-supplied weights or addresses. Portfolio
and withdrawals discover/select all saved investment slots. Update exports/capability
gates and native confirmation copy. Regenerate bindings from Rust. Run Android
unit tests and native compilation with the established local toolchain.

## Task 4: Mobile contracts and experience

Owner scope: TypeScript/React under `mobile/src`, mobile JS tests, docs.
Extend versioned decoding and services to distribution metadata, per-slot payout
legs, review and progress; legacy fixtures remain valid. Guided review displays
wallet count, weights, independent fees/reserves and progress. Ethereum's staged
controller iterates the saved investment slots without dropping its existing
approvals. Portfolio/withdrawal UI selects the right wallet slot. Gate new
preparation on updated native capability. Add functional tests for one/two/five
wallets, stale native builds, partial completion, resume and legacy records.
Run mobile tests/typecheck/lint/format checks.

## Review focus

- No collision between distribution slots, confidential identity and legacy keys.
- Multi-source rounding conserves all input and is independent of fragmentation.
- Idempotency/fingerprints distinguish sibling slots and reject changed weights.
- Incomplete/signed legs never reset, reroll or cause successful deposits to repeat.
- One native approval binds every selected wallet's exact fee/minimum/reserve limits.
- Restore and withdrawals retain per-wallet ownership, including old deposits.

## Integration

Review all diffs together, resolve interface mismatches, run full relevant suites
and independently review the complete change. Update implementation documentation
and report checks accurately. Keep the feature local unless the user requests push.

## Implementation verification — 2026-11-05

All four tasks are implemented locally on `feat/distribution-algorithm`.

- Rust stored signer: 200 tests passed; formatting/checks passed.
- Backend: 263 tests passed, 4 skipped; typecheck and build passed.
- Mobile: 773 tests across 91 suites passed; typecheck, lint and changed-file
  formatting passed.
- Android: 326 tests passed, no failures/errors/skips; signer library
  `assembleDebug` passed. Changed Kotlin formatting and `git diff --check` passed.
- Independent review found and resolved the staged Ethereum journal-capacity
  issue. New funding checks cover batch and individual/resume authorization
  while preserving previously signed recovery.
- Regressions cover one/two/five-wallet guided approval, partial sibling progress,
  saved-budget hydration, draft discard, Ethereum multi-wallet stages and saved
  progress reopening, actual encrypted backup restoration, portfolio discovery,
  legacy records and older native capability gates.

These are local automated checks. No funded device transaction, deployment,
commit or push was performed. Deploy the backend contract changes before using
new deposits from a rebuilt native app; an OTA-only JavaScript update cannot add
the new signer APIs.

## Integration with wallet recovery — 2026-11-05

Merged `origin/main` at `46516ec`, which includes wallet discovery/recovery, into
the distribution branch. Kept both native capability families, immutable
distribution plans and the recovery allocation high-water mark. Backend shared
credit bindings include the saved plan, and replay results retain distribution
metadata across replicas.

Recovery recognizes already tracked distribution slots, preserves the investment
slot during withdrawal reconciliation, merges per-slot withdrawal receiver indices
monotonically, and rejects changes to saved allocation weights or signing identity.
Funding capacity counts pending operations instead of retained settled history.
Distribution payout storage reservations account for their serialized recovery
representation so ordinary five-wallet/two-source deposits remain supported.
Existing signed records keep their recovery path.

Verification on the integrated tree:

- Mobile: 94 suites / 802 tests passed; typecheck and lint passed.
- Backend: 293 tests passed, 3 opt-in fork tests skipped; real PostgreSQL
  distribution replay/replica tests, typecheck and build passed.
- Rust: 204 tests passed; Android bindings regenerated.
- Android: 64 suites / 365 tests passed; full debug app assembled. Cross-feature
  regressions cover discovery ownership, restored plan/slot identity, monotonic
  recipient maps, settled history capacity and bounded payout persistence.
- Independent integration review passed. Changed Kotlin files are format-clean;
  the full formatter check still flags pre-existing differences in
  `swap/SwapScreens.kt` and `swap/SwapEngine.kt`, which were left unchanged.

No production deployment or funded device transaction was performed.
