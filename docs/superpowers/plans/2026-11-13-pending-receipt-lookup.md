# Pending receipt lookup: narrow fix

User-approved scope: keep the existing flow, UI polling, native host, journals,
backend APIs and spending approvals. Change only the sponsored receipt verifier
and regression tests unless a failing reproduction establishes another necessity.

The old build's 17:29:20 diagnostic identified `EarnSponsoredReconciler.kt:93`:
a receipt was present while the separate bundler operation lookup was absent.
The assertion stopped native execution and the resulting pause stopped UI polling.

- [x] Add a failing regression for this exact response combination, binding
  validation, nonce reservation, no resend, eventual full verification and unrelated operations.
- [x] Add a continuously foreground native-host regression through payout wait
  (step 3) and delayed vault receipt verification (step 4), with one approval and
  one execution per child. Use real receipt verification with mocked RPC transport.
- [x] Apply the minimum verifier change and verify affected tests, including
  strict receipt checks, reorg/revert handling and approval revocation.
- [x] Run the full native suite, report established baseline failures, and run
  relevant existing rendered deposit tests. Review the incremental patch.
- [x] Build standalone arm64 release pinned to api.gizu.io, verify package and
  signing identity, install with `adb install -r`, and open Gizu.

Preserve the current dirty checkout and all earlier changes. No transaction will
be executed on the user's device for verification; funds have already been
successfully deposited. Source baseline: `/tmp/gizu-receipt-fix-before`.

## Verification record

The new tests failed on the original lookup assertion. The continuously foreground
regression uses the current one-wallet distribution, real native host/coordinator
and receipt verifier with RPC/signing fixtures. It observes payouts pending, then
vault deposit pending, then all four steps completed, with one approval, exactly
three child executions and zero saved-payout retries. No lifecycle event or reopen
is used. All 59 affected native tests pass, including the four new cases.

Production changes are confined to `EarnSponsoredReconciler.kt`: keep a receipt
whose operation lookup is absent pending, and do not turn that pending operation
back into sendable signed state if a subsequent provider response is also empty.
Nonce conflicts still become unknown; full verification still requires all existing
checks. No UI, host, journal format, API or approval change was needed.


Independent review of the incremental patch found no findings. Shared funding,
withdrawal, adapter and recovery callers retain nonce blocking and cannot resume a
pending signed operation. The regression uses real verifier/Host/Coordinator with
RPC and engine fixtures; it does not claim live adapter or on-chain execution.

Full native suite: 543 tests, 536 passed, the same seven established
`EarnDepositPreparerTest` fixture failures:

- `cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview`
- `independentPayoutPreviewsOverlapBeforeTheVaultRead`
- `payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData`
- `missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation`
- `reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair`
- `slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums`
- `continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending`

These were reproduced against the initial source baseline earlier in this chat;
no new failures occurred. Affected rendered deposit and service suites: 51 tests
passed. Logs: `/tmp/gizu-receipt-fix-native-full.log` and
`/tmp/gizu-receipt-fix-ui.log`. `git diff --check` passed.


Standalone release build passed (879 tasks). Native release code was recompiled;
API api.gizu.io, hosted backend mode, DEBUG=false, arm64 signer, existing package
and signing certificate were verified. Installation was attempted with -r but
ADB reported the device was no longer connected. The user has been asked to
reconnect it; installation/opening remain pending. Backend sources are unchanged.


Installation completed after the user reconnected device RFCWA0F5SAN.
The preserved tested APK `/tmp/gizu-pending-receipt-release.apk` matched SHA-256
`04f855ec9ba2f6913fa2745d77da14ad9b5a9a0399a5991f95b6ceeed7157b7c`.
`adb install -r` returned Success; MainActivity cold launch returned Status ok.
Installed lastUpdateTime: 2026-11-13 18:18:26 Europe/Istanbul. Standalone flags
contain no DEBUGGABLE flag. Wallet/app data was preserved. No backend deployment,
transaction signing, resubmission or new deposit was performed.
