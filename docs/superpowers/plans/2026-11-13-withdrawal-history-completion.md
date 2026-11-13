# Withdrawal history completion implementation plan

**Superseded on 2026-11-14:** The authenticated-history recovery approach below violated the user's no-invite-only-history constraint. Do not use it or request history entitlement. The correction is [terminal withdrawal completion](2026-11-14-terminal-withdrawals.md): save the final private-return completion once and do not reopen it.

**Goal:** Completed returns stay complete after their USDC is spent; opening Withdraw never describes investment inventory as an active withdrawal.

**Architecture:** Keep native journals and existing exit checks authoritative. Reuse authenticated provider history to recover a missing minimum receipt, with an explicit opt-in header and the same durable route binding. No transaction execution, resubmission, financial approval, history deletion or backend deployment is part of verification.

**Tech stack:** TypeScript, React Native, Kotlin, existing Aurora history and PostgreSQL receipt adapters.

## Constraints and decisions

- Preserve the dirty workspace in place; snapshot this task's starting files under `/tmp/gizu-withdrawal-fix-before`. Do not commit unrelated changes.
- User explicitly requested the fix after diagnosis; implement inline without another approval round.
- The old balance-delta endpoint behavior remains available to old clients. Updated clients opt into authenticated history recovery using a second header; old servers safely ignore that header.
- A verified historical route can create a minimum-only receipt. It cannot authorize spending or claim an exact current balance.
- Recovery must validate quote, origin transaction, recipient, owner, asset and input amount. Missing or unavailable authenticated history stays uncertain; never infer completion from route SUCCESS alone.
- Read verification uses the already approved wallet read session. Revoked read authority fails closed; spending approvals are unchanged.
- All-profile saved investment counts are not withdrawal progress. Remove that misleading counter, preserving historical status/recovery controls.

## Review focus

- Money received and spent before the first settlement check.
- Another return advances the shared-account observation sequence.
- A provider history record belongs to a different route, transaction or recipient.
- Screen lock or cancellation while an automatic read is running.
- Old backend deployed during app update: retain old minimum checks and fail closed.

## Tasks

- [x] Add failing backend recovery regressions, keeping existing balance-delta tests unchanged; implement opt-in history recovery and durable replay. Run backend tests and typecheck.
- [x] Add failing UI regressions for spent verified returns, old unverified history plus a current investment, true pending activity and unavailable reads. Remove balance dependence and the inventory counter; perform bounded read-only recovery before classifying history.
- [x] Use shared native read authority for settlement reads and label missing historical private proof as verification needed, separately from a pending onchain return. Test native inventory and read authority.
- [x] Run JavaScript/native regression suites and an independent read-only review of this task's patch. Record baseline failures separately.
- [x] Build the standalone production app, verify identity/API configuration, install without clearing device data, and report backend deployment requirements. Do not execute a financial operation.

## Evidence

- Reproduced device banner and old return transaction with missing private confirmation; no evidence that a new withdrawal was initiated.
- Existing functional regression for history inventory counting fails before this fix.
- Root causes: all saved investments used as withdrawal denominator; current private holdings used for historical completion; an uncaptured balance-delta receipt cannot recover after an intervening debit.
- Backend: 480 total, 468 passed, 12 skipped; TypeScript passed. The first sandboxed run could not start localhost/process fixtures; the permitted rerun passed without changing those tests.
- Native: 546 total, 539 passed, seven established `EarnDepositPreparerTest` baseline failures. Their names and the fake-payout floor mismatch are documented in `2026-11-13-shared-earn-private-usdc.md`; no production minimum or fixtures were weakened.
- Final full JavaScript suite: 107 suites / 1024 tests passed. Affected final tests: 76 passed. Mobile TypeScript, scoped ESLint and formatting checks passed. Backend TypeScript and build passed.
- New tests observed RED then GREEN: history recovery before first receipt, account sequence advancement, unavailable history, misleading inventory counter, historical read recovery, cancelled fresh completion, missing native private proof, older return versus later primary, locked read unlock/retry, and later-primary panel controls.

## Independent review and rulings

- Read-only reviewer `review_withdrawal_completion`: no Critical findings; backend bindings and sequence fencing accepted.
- Important finding fixed: revoked read permission left Withdraw without an unlock control. The screen now owns the shared balance/unlock control and retries status after that explicit read-only action. The lock → unlock → retry regression failed before the fix and passes afterward.
- Reviewer set aside an older panel-control ordering defect as preexisting. Ruling: fix it here because it can reproduce the same stale-return experience and suppress a later real withdrawal. Reuse `latestPrivateReturn` for both completion and controls; invested/withdrawn ordering regressions failed before and pass afterward. Cost if wrong: incorrect selection of the next withdrawal control; covered by those tests.
- Ruling: retain the existing dirty checkout and produce task-scoped baseline/patch artifacts rather than committing unrelated work. No branch merge, push or backend deployment performed.
- No deferred minor review findings.

## Existing native fixture failures

These seven failures were present before this task; the fixture payout is below
the existing conservative routing floor:

- `EarnDepositPreparerTest.cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview`
- `EarnDepositPreparerTest.independentPayoutPreviewsOverlapBeforeTheVaultRead`
- `EarnDepositPreparerTest.payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData`
- `EarnDepositPreparerTest.missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation`
- `EarnDepositPreparerTest.reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair`
- `EarnDepositPreparerTest.slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums`
- `EarnDepositPreparerTest.continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending`


## Release evidence

- Standalone Android `assembleRelease` passed, arm64-v8a, `DEBUG=false`.
- Preserved package `com.example.gizu.dev`, version 0.5.2 (11), and installed signer SHA-256 `9b241fadf59f6bd0707b928859468c63c69b3ecb9b1060fb5a2b3a4f4bc21c67`.
- Bundled `api.gizu.io`; native backend mode `hosted`; updated historical-recovery header present in release DEX.
- Frozen APK `/tmp/gizu-withdrawal-completion-release.apk`, SHA-256 `24fea22b88d923fce151d43ab9c41f56f076aa406567383a8204d9be2078fb79`.
- Backend task patch `/tmp/gizu-withdrawal-backend.patch`; complete task baseline/patch `/tmp/gizu-withdrawal-fix-before` and `/tmp/gizu-withdrawal-completion.patch`.
- Backend changes are prepared locally, not deployed. Live provider-history repair of the user's saved record is unverified and requires deployment plus the owner's authenticated read session. Regression tests use provider/native fixtures, not a live financial transaction.

- ADB `install -r` succeeded on Samsung S23 `RFCWA0F5SAN`; installed update time 2026-11-13 18:51:51 Europe/Istanbul. Explicit Gizu activity launch succeeded. No wallet data clear, financial approval or transaction was performed.
- Device display was dozing during launch verification; Gizu process/activity were present. Live authenticated screen verification was not performed.
