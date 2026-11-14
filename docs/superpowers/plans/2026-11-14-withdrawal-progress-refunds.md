# Withdrawal progress and refund correction

**Goal:** Reuse the existing deposit ladder for the four withdrawal stages requested by the owner, with live private-return/refund state and a safe fresh-review retry. Keep native spending approvals and Account 2 unchanged.

**Incident evidence:** An on-device full withdrawal redeemed the vault and sent its proceeds to the provider. The ordinary status endpoint moved from PROCESSING to REFUNDED, and the refund was verified in the source wallet. Account 2 remained unchanged. Home’s collapsed asset row did not identify public USDG. Exact user transaction/account diagnostics remain outside the repository.

**Confirmed defects:** A finalized origin transfer without private credit becomes historical `checking`, so Home hides the active withdrawal entry. REFUNDED is absent from the Earn lifecycle, leaving a received public refund looking like missing private credit and blocking an appropriate return retry. The withdrawal lacks the existing ladder and automatic read-only progress updates. No private credit may be fabricated from provider SUCCESS or an owner report.

**Timing concern:** Earn currently uses the same ten-minute bound for provider refund and local signing. The observed refund occurred about ten minutes after transfer, but Aurora's status response supplies no explicit reason. Separate the provider's longer settlement window from the unchanged ten-minute local quote/signing bound; preserve strict quote identity and native approval lifetimes. This addresses a concrete short settlement window, without claiming the provider's exact refund reason is known.

## Implementation

- [x] Add failing native regressions for current-return classification, native-observed REFUNDED, source retry admission and private-credit serialization. Keep a refund distinct from successful private completion. Do not relax ordinary signed/unknown return admission.
- [x] Read ordinary route status for the latest finalized requested return and persist it in the encrypted native row, bound to wallet/generation/proposal/origin transaction. Expose only safe progress and current public USDG. A verified refund can release that failed incoming credit; retry still needs fresh native approval, live cash and the original proceeds budget. Never redeem again to retry a private return.
- [x] Add backend regressions for a longer Robinhood provider settlement deadline with the existing local quote expiry; leave other routes and UserOp/passkey lifetimes unchanged.
- [x] Extract the exact deposit ladder markup into a shared presentation component. Reuse it in deposit and withdrawal. Cover vault pending, quote ready, origin sent, private receipt, processing, read failure and refunded views.
- [x] Add read-only polling and a current-withdrawal Home action, including when shares are zero. Keep historical correction separate. Show USDG identity and amount in its asset row.
- [x] Run affected then full app/backend/native regressions; review source/refund admission and lifecycle consumers; build api.gizu.io release, install preserving data, inspect the existing refund without sending a live transaction. Push the correction on the current branch; backend deployment remains owner-operated.

## Review corrections and validation

The shared ladder and automatic read-only received transition pass functional regressions. Native tests cover refund/source binding, fresh approval for linked and legacy returns (including cancelled drafts), authenticated encrypted restore validating/rebinding terminal refund metadata while discarding nonterminal observations, successful retry followed by a later partial withdrawal, and routing-terminal origin preservation without creating private credit.

Full app final suite: 1,104 tests / 112 suites passed. The signed-observation regression failed before the fix and passed afterward. Full backend suite: 498 tests, 486 passed, 12 optional skips, no failures (rerun with the local server/child-process permissions those tests require). Typechecks pass. Full native suite: 584 tests, 577 passed, the same seven existing deposit-preparer fixture failures. Production release built and certificate verified. No live financial transaction has been sent by the agent.

## Delivery and device verification

Correction commit `4803364` was pushed on `feat/return-status-consistency`; the owner confirmed backend deployment. The api.gizu.io release was installed on the connected phone preserving app data. After normal login, Home showed the current Aurora refund notice and public USDG quantity. The withdrawal view reused the existing ladder, with the first three stages complete and the missing private receipt requiring attention. A fresh read-only private-return quote loaded successfully and required a separate confirmation. The quote was dismissed using Android Back; the phone was left on Home showing the refund notice. No retry was approved or submitted. Completion after a new live return remains covered by regressions rather than a live financial test.

The unchanged native fixture failures are in EarnDepositPreparerTest:

- cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview
- independentPayoutPreviewsOverlapBeforeTheVaultRead
- payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData
- missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation
- reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair
- slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums
- continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending

These use 0.099 USDC fixture portions below the established 0.17 routing minimum. The production routing minimum was not changed.
