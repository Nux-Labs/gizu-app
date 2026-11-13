# Shared Earn Private USDC Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** New Earn funding and newly prepared investment returns use the wallet's Account 2 private USDC balance.

**Architecture:** Preserve historical derivation functions and saved operations. Persist a shared-private-account marker on new Earn cycles; their funding, read authentication and payout signer use Account 2. Export Account 2 separately as the return destination so new returns from historical investments also credit Account 2, while saved legacy returns retain their original identity.

**Tech Stack:** Shared Rust signer, Kotlin Android orchestration/storage, Swift native metadata, TypeScript domain/service adapters, Cargo/JUnit/Jest.

**Spec:** User-approved flow in this chat, 13 November 2026: replace per-investment private funding and return accounts with Account 2. Existing private balances and saved operations must remain recoverable.

## Global Constraints

- Preserve existing uncommitted work in this checkout; do not reset, stash, or replace it.
- No changes to historical derivation paths, derived destination wallets, signed bytes, or provider confidentiality settings.
- Public top-ups require verified private credit before payout.
- New return plans must target Account 2, including returns from historical investments.
- Keep legacy private accounts discoverable and spendable; saved legacy operations may finish at their original recipient.
- Keep native ownership validation strict: Account 2 or the exact historical private key for the selected profile and cycle, never arbitrary caller-selected signers.

## Review Focus

- Old investments with new returns must credit Account 2 without invalidating saved legacy return signatures.
- Mixed private/public deposits must not spend before the top-up's private credit is verified.
- Shared private balance changes must not be attributed to two simultaneous operations.
- Recovery and backups must retain the shared marker and historical private balances.
- A changed quote recipient or foreign signing key must still be rejected.

### Task 1: Shared signer identity

- [x] Add failing Rust tests for source funding, payout signing and investment returns using Account 2; retain legacy and foreign-recipient rejection coverage.
- [x] Run the focused tests and confirm the expected failures.
- [x] Resolve the private signing key from the approved owned identity (Account 2 or exact legacy profile/cycle key) without changing legacy derivation exports.
- [x] Run the full shared signer suite and formatting check.

### Task 2: Native routing, storage and reconciliation

- [x] Add failing native tests for new cycle shared identity, historical identity preservation, Account 2 authentication and shared credit sequencing.
- [x] Persist the shared marker on new cycles and select Account 2 for their funding and payouts.
- [x] Prepare new return quotes for Account 2; authenticate settlement against each saved route's actual private recipient.
- [x] Preserve historical portfolio discovery and pending operation recovery; update matching iOS metadata/read behavior within its existing capabilities.
- [x] Build the host/native signer and run the affected JVM suite, then the module suite.

### Task 3: App return contract and verification

- [x] Add failing domain/service tests for Account 2 return plans on historical investments and legacy receipt compatibility.
- [x] Carry the native return destination through the Earn intent and return planning adapters; bind new quote validation to it and retain validation of historical saved receipts.
- [x] Update relevant architecture documentation and native confirmation copy.
- [x] Run TypeScript, relevant app tests, complete mobile tests and required native checks; report unavailable device checks explicitly.
- [x] Review the final incremental changes for regression risks and address findings before completion.

## Baseline

- Existing shared Rust signer suite: 241 tests passed before edits.
- Work is in the user's existing `fix/confidential-earn` checkout because it contains the in-progress Earn implementation being revised.

## Execution record

- Shared Rust baseline: 241 passed. New Account 2 funding, payout signing, and return tests failed with `InvalidInput` before the signer change, then passed.
- Shared Rust suite after the cross-flow spend regression: 245 passed. A funded Swap with 6 USDC already private previously spent that cash; it now preserves that cash and leaves unspent route surplus private.
- Native Account 2 tests were observed failing before routing, recovery marker, profile-independent journal read, nonce cancellation, signed-cancelled Swap, and private inventory fixes. Affected suites passed after fixes.
- The final complete mobile suite passed 107 suites / 1011 tests. TypeScript and scoped ESLint pass.
- The full native suite reports 529 tests (522 passed), with seven failures confined to existing `EarnDepositPreparerTest` preview cases. Its already-present `PAYOUT_QUOTE_FLOOR` rejects the fixture's 0.099-USDC hold payout. Do not lower the production bridge minimum to make those fixtures pass.
- iOS Swift source syntax parsing passed. Simulator tests cannot run: this machine has CommandLineTools and no `simctl`/iOS runtime.
- Native Android signer host and arm64 release builds passed. No transaction or private-balance migration was sent.

### Review fixes

The independent read-only review identified ownership-marker merge conflicts,
profile-gated inventory reads, confirmed nonce-cancellation liveness, legacy
candidate authentication, outstanding private payout reservations, cancelled
Swap incoming funding, unused legacy private targets, fresh-return destination
enforcement, and funded Swap overspending. Fixes and regression coverage are in
the working tree; historical derivation and signed bytes remain unchanged.

Ruling: preserve the current in-progress checkout and all prior edits; no new
checkout or commit is created because the requested flow is built on that work.
Ruling: legacy signed or pending routes keep their saved private identity; newly
prepared return routes use Account 2. Changing saved signatures would invalidate
recoverability.

### Final baseline comparison

The original Kotlin source snapshot was rebuilt independently with an alternate
source set and incremental compilation disabled. `EarnDepositPreparerTest` ran
12 tests and reproduced exactly the same seven failures as the complete current
suite. Their names are:

- `cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview`
- `independentPayoutPreviewsOverlapBeforeTheVaultRead`
- `payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData`
- `missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation`
- `reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair`
- `slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums`
- `continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending`

No production bridge minimum was reduced. The alternate source set lives only in
`/tmp`; the project sources were never replaced by the comparison snapshot.

Final affected native verification: 87 tests across 9 suites passed, including shared identity, historical returns, recovery, mixed funding, payout reservations, cancellation, and private inventory.

Final Android verification: `:app:assembleDebug` passed (565 tasks). The APK archive and packaged arm64 signer were verified. The APK was not installed and no live investment or withdrawal was submitted.

### Device follow-up: exact unroutable deposit amounts

The user entered 1.9 USDC against a displayed private balance of 1.942172 USDC.
The device recorded `stage=sources code=BELOW_ROUTE` at the public-remainder
minimum check. The old diagnostic did not record the selected amounts, so the
user's actual private-only budget cannot be inferred from it. A 1.9 USDC budget
selects one investment wallet under the distribution algorithm.

Native preparation now returns a safe amount explanation through the existing
snapshot `message`: selected private budget, uncovered remainder and the saved
distribution's minimum public budget. Zero selected private funds and legacy
public-funded drafts have distinct minimum explanations. The UI displays this
message for `uneconomicAmount`; it no longer tells the user to lower the amount
until something works. No signing, routing or fee minimum was changed.

Verification: the rendered warning regression failed before the UI fix and then
passed. All 107 JavaScript suites / 1,012 tests, TypeScript and scoped ESLint
passed. The complete native run had 533 tests with exactly the seven baseline
failures named above. After adding the final legacy-message case, all 12 affected
native checks passed. Tests use synthetic balances; their 1.8 USDC example is not
the user's measured budget.

The standalone arm64 release build passed (879 tasks), with hosted native backend
mode, `DEBUG=false` and `EXPO_PUBLIC_API_URL=https://api.gizu.io`. It uses the
existing application ID and signing certificate for an in-place data-preserving
update. No backend source changed and no AWS deployment is required.

Device verification: `adb install -r` succeeded and the standalone app opened.
The first unsigned review lost its read-only permission during preparation
(`GizuStoredSignerModule.kt:2766`); the UI currently reports that expiry as a fee
preview failure. The user explicitly renewed “Check private cash” and completed
the passkey prompt. The next unsigned 1.9 USDC review reached the amount check and
displayed 1.885469 USDC of routable private funds, a 0.014531 USDC funding shortfall
and a 0.2 USDC minimum public budget. The displayed total private balance was
1.942172 USDC, leaving 0.056703 USDC below the per-source routing floor. No deposit
was confirmed, signed or submitted. Read-permission expiry classification remains
a separate known limitation; amount rejection now displays its numeric cause.
