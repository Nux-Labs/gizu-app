# Wallet Discovery and Recovery Implementation Plan

> **For agentic workers:** Use the approved design and scoped task ownership. Implement with failing regression tests first and independently review the final branch.

**Goal:** scalable client-owned wallet tracking and recovery without a readable server-side wallet catalogue.
**Architecture:** native encrypted metadata/history plus client-encrypted remote recovery, resumable discovery, shared opaque backend coordination, and a capability-gated Account UI.
**Tech Stack:** existing Rust/UniFFI, Android Kotlin, React Native/TypeScript, Fastify/PostgreSQL.
**Spec:** `docs/superpowers/specs/2026-11-05-wallet-discovery-recovery-design.md`.
**Base:** origin/main `7415714`; distribution work remains separately pushed at `26a32fc`.

## Global Constraints

User approved implementation and push. Preserve native secret/signing boundaries,
legacy recovery and all signed operations. Temporary address processing is allowed;
persistent server records/logs contain no readable addresses/user-wallet mapping.
No production deployment, funded transaction or merge to main.

## Review Focus

- A stale backup and interrupted sync cannot reuse an allocated cycle.
- Restart/replica races cannot duplicate a financial submission or forget consumed authority.
- Neither encrypted server-authenticated operation envelopes nor address hashes are
  misrepresented as client-private recovery storage.
- Discovery cannot authorize spending, fabricate weights or mark a partial scan complete.
- Pagination migration and compaction preserve uncertain signed work and legacy backup access.

### Task 1: Backend private persistence and distributed coordination

Scope: backend only. Add failing tests, implement safe logging, opaque authenticated
CAS recovery storage/API in PG, minimal shared expiring coordination and gateway
wiring. Include two-instance/restart/tamper/retention/no-address tests. Run backend
tests, typecheck and build. Native uses the exact backup API from the spec.

### Task 2: Native persistence, recovery sync and discovery orchestration

Scope: Android Kotlin and tests. Migrate encrypted catalogue/journals to bounded
pages, implement native recovery encryption/material/API client, restore monotonic
metadata, wire pre-funding/pre-broadcast persistence and read-only discovery with
cursors. Expose only the public status/actions in the spec; capability gates.
Coordinate derivation candidate contract with Task 3. Run native tests and build.

### Task 3: Shared Rust discovery derivation

Scope: stored-signer core only. Export
`wallet_discovery_candidates(entropy: Vec<u8>, chain_id: u64, cycle_index: u32) -> String`
(JSON native-only list of `{derivation, role, slot?, address}`), returning legacy
hold/invest/confidential plus five distribution-v1 investment slots. Preserve
legacy derivations and checked bounds. Test collision/stability/invalid inputs,
no dependence on distribution feature ancestry. Run Rust tests and regenerate
bindings for Android owner after exports stabilize.

### Task 4: Mobile recovery UI and integration

Scope: mobile TypeScript/tests and docs. Define/decode the exact native contract,
capability-gate adapters, add Account backup-area recovery controls and real
functional tests for sync, older-backup restore, scan progress/cancel and errors.
Run mobile tests/typecheck/lint/changed-file formatting. Integrate native/backend
contracts, independently review, fix verified important findings, commit and push
`feat/wallet-discovery-recovery`. Verify main ancestry and clean working tree.

## Implementation and verification notes — 2026-11-05

Implemented all four scopes. Independent review covered backend persistence and
replica coordination, native migration/restore and signed-history preservation,
derivation compatibility, discovery consent/cancellation, UI capability gates,
and crash-safe local/remote page cleanup. Verified findings were corrected with
regression coverage. Backend upload admission additionally prevents credential
rotation from bypassing per-credential quotas; payout caches expire rather than
exhausting a process after its first 512 operations.

Verified on this branch:

- Mobile: 93 suites / 777 tests passed; TypeScript and ESLint passed.
- Native: 62 suites / 330 tests passed; full Android debug app assembled.
- Rust: 192 tests passed; Android Rust build and generated bindings succeeded.
- Backend: 287 tests / 284 passed, 3 conditional fork tests skipped, no failures;
  real PostgreSQL replica/CAS/quota tests included. Typecheck and build passed.

Native verification used Java 17 and the installed Android SDK. PostgreSQL tests
use an isolated temporary local database, including real replica/CAS races.
No emulator/device, production deployment, production database mutation, or live
financial transaction was performed. New recovery/discovery capabilities are
Android-only and fail closed on unsupported builds. See
`docs/internal/WALLET_DISCOVERY_RECOVERY.md` and `backend/docs/wallet-recovery.md`
for rollout requirements and explicit storage/discovery limits.
