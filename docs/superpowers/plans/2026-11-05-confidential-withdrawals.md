# Confidential Withdrawals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain new vault/sale proceeds privately and add explicitly approved
algorithm-distributed public USDC cashout.

**Architecture:** Preserve native account derivation and old saved-operation policy.
Add a separate native generic cashout journal/signing policy using deployed Aurora
routes and a shared private-spend exclusion boundary. TypeScript only composes
readable private-exit/cashout screens and validates public native results.

**Tech Stack:** Rust/UniFFI, Kotlin/Android, React Native/TypeScript, existing Aurora
gateway and encrypted native wallet files.

**Spec:** `docs/superpowers/specs/2026-11-05-confidential-withdrawals-design.md`

## Global Constraints

- Incoming and existing public USDC and purchase/deposit funding remain unchanged.
- Distribution uses the existing native 1–5 wallet algorithm and fresh receiving roles.
- Exact private-USDC input budget; source/payout sums exact; fees affect net output.
- Native authorization and saved signed bytes; no automatic approval or funded tests.
- No reallocation on resume, no early completion from aggregate balance/status alone.
- Keep legacy saved operations recoverable; absent sale policy means public payout.
- Backend temporarily processes requests; no retained user/address catalogue.
- No production deployment, merge or push to a shared branch during implementation.

## Review Focus

- Credit from an unrelated operation must not finish a new private sale or vault exit.
- Unknown signed work must keep reservations and must not be signed/reallocated twice.
- Multiple confidential accounts and rounding must preserve the exact approved budget.
- Old saved public-return operations must remain recoverable under their old policy.
- Private/public/vault balances must be counted once, with stale reads explicit.

### Task 1: Native distributed cashout

**Files:** New `core/src/confidential_withdrawal.rs` and focused Rust tests; export
from `core/src/lib.rs`; new Android `withdrawal/` native plan/journal/gateway/engine
files and tests; native module/guard integration; minimal native catalogue accessor.

**Interfaces:** Native Expo methods `getConfidentialWithdrawal(walletId)`,
`prepareConfidentialWithdrawal({walletId,amountAtoms})`,
`executeConfidentialWithdrawal({walletId,operationId,revision})`,
`resumeConfidentialWithdrawal({walletId,operationId})`,
`cancelConfidentialWithdrawal({walletId,operationId})`.
No active operation returns null. Public view contains `walletId`, `operationId`,
`revision`, `amountAtoms`, `minimumDestinationAtoms`, `receivedAtoms`, `walletCount`,
`weightsBps`, `status` (`review|pending|unknown|paid|cancelled|needsReview|conflict`),
`canResume`, `canCancel`, and `payouts` with `slot`, input/minimum/received atoms and
status. Publish `confidentialWithdrawals: true` only when implemented.

- [x] Write and run failing exact amount/derivation/quote/approval and journal tests.
- [x] Implement separate strict cashout policy; reuse quote and intent validation.
- [x] Implement native authenticated source selection, one persisted distribution,
  encrypted journal, same-byte reconciliation and shared spending exclusion.
- [x] Include multi-source rounding, stale/foreign evidence, conflicting spends,
  crash/unknown/partial payout and unsigned-cancel regressions.
- [x] Run affected Rust/Kotlin tests and compile bindings/native module.
- [x] Review the final diff; correct important findings; checkpoint the task.

### Task 2: New sale private completion

**Files:** `core/src/swap/engine.rs`, corresponding engine tests, Android
`swap/SwapEngine.kt`, `swap/SwapPortfolioStore.kt` and targeted tests as applicable.

**Interfaces:** New native sale plans carry `completionTarget: "confidential"`;
absence preserves legacy public payout. Public status/history includes this policy
and independently verified private credited amount. No fresh public recipients
are allocated for a new confidential sale.

- [x] Add failing new-sale terminal, unrelated balance, unauthorized fallback and
  legacy resume tests; observe failures.
- [x] Add explicit policy and authenticated operation-specific credit reconciliation
  before private completion. Preserve pending/signed sale/order recovery.
- [x] Remove new-sale receiving-wallet allocation; retain source holder derivation.
- [x] Enforce cashout exclusion before competing private spend and test rejection.
- [x] Run affected core/native tests; review and checkpoint.

### Task 3: Private vault exit completion and app cashout

**Files:** `domain/wallet/confidentialWithdrawal.ts`,
`services/wallet/confidentialWithdrawal.ts`, new wallet withdrawal screen/controller;
navigation and Home actions; `domain/wallet/storedSigner.ts`, `nativeBridge.ts`;
`features/earn/ExitCompletionPanel.tsx`, `useVaultPosition.ts`, execution panels;
swap completion/history presentation; functional tests.

**Interfaces:** Strict typed adapter for Task 1's native methods/view. New route
`ConfidentialWithdrawal: undefined`. Vault completion consumes verified private
return credits with fresh zero-share/residual evidence rather than paid public
receiving children; existing public children remain resume/reconcile-only.

- [x] Write failing real-screen functional tests for private exit, no new public
  payout, exact cashout form/review/progress, failed/rejected/late/foreign results,
  legacy sale/public withdrawals, and unchanged public funding.
- [x] Implement new explicit cashout UI using native capability and read-only
  portfolio private cash; native source checks remain authoritative.
- [x] Change vault completion/checkpoints and sale/history wording by saved policy.
- [x] Refresh private/public portfolio after credit/payout without double counting.
- [x] Run affected functional tests, typecheck/lint; review and checkpoint.

### Task 4: Integrated verification and device build

- [x] Run complete mobile JavaScript, Kotlin and Rust checks; changed-file formatting.
- [x] Independently review aggregation, native review bounds, shared private spending,
  legacy journals, recovery and no-replay/partial settlement contracts.
- [x] Fix important findings with regressions and rerun affected checks.
- [x] Build standalone Render APK with the existing certificate.
- [x] Update/open phone preserving app data after USB reconnect. Inspect screens
  only; never authorize funds.
- [x] Record exact checks, supported platforms and live provider limits in the spec.

## Final integration verification

- Mobile `npm test -- --silent`: 878 tests across 99 suites passed. Full
  `typecheck`, ESLint and Prettier checks passed.
- Stored signer `cargo test --locked`: 219 tests passed. Changed Rust files pass
  rustfmt. A deadline-sensitive legacy test expired during a long host pause;
  its isolated rerun and subsequent complete 219-test run passed without changing
  the deadline guards or that test.
- Android `:gizu-stored-signer:testDebugUnitTest`: 395 tests across 70 suites
  passed, zero skipped. Final regenerated Rust host/arm64 libraries were used.
  All 18 changed Kotlin files pass pinned ktfmt 0.54.
- Backend `npm test`: 292 passed, 10 skipped, zero failed; `npm run typecheck`
  passed. The skips are existing environment-dependent integration cases.
- Independent sale, app, cashout and cache reviews completed. Findings fixed with
  regressions: legacy status-only cancellations, cancelled swaps retaining signed
  private payouts, local signing-marker interruption, receipt-event replay across
  equal-value children, partial quote recovery, stale sold holdings/private credit
  overlap and fresh-zero public receiver caching after cashout.
- Backend routes remain undeployed. A harmless empty-body POST to hosted
  `/v1/swap/aurora/history` returned 404. New sale preflight blocks before funds
  move when that endpoint is unavailable. No user-funded transaction was tested.

Native and sale task reports are saved beside this plan.

Standalone Render release build succeeded (`:app:assembleRelease`, arm64-v8a).
The bundle contains the Render API URL and new private-withdrawal capabilities.
The packaged native library matches the freshly generated signer through the
Android merge/strip steps. Certificate SHA-256 remains
`9b241fadf59f6bd0707b928859468c63c69b3ecb9b1060fb5a2b3a4f4bc21c67`.

APK: `mobile/android/app/build/outputs/apk/release/app-release.apk` (54,831,003 bytes),
SHA-256 `839bf9cbe3d4ab15ed646bef67a265785fd297d7144fca909740d5a5de11a867`.
After USB reconnection, `adb install -r` succeeded on the Galaxy S23
(`RFCWA0F5SAN`). The APK hash still matched the verified release above.
Launching `com.example.gizu.dev/io.gizu.android.MainActivity` returned `Status: ok`
with a cold start. UI inspection showed the welcome screen and **Continue with
passkey**; the app is open and awaiting the user's unlock. Installation preserved
app data; no restore, data-clear or financial authorization was performed.
