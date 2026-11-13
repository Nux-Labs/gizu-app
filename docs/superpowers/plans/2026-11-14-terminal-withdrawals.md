# Terminal withdrawal completion implementation plan

**Goal:** Once the saved native withdrawal and private-return steps have completed, the withdrawal stays done without new balance, route or history checks.

**Architecture:** Reuse the encrypted native minimum-return/credited receipt as the terminal completion record. Project it as returned in investment inventory and accept it directly in the withdrawal controller. Remove the unsupported history-recovery fallback; retain existing checks while a return has not completed and all spending approvals.

The user's explicit completion rule supplies the design: vault withdrawal → public USDG → expected minimum private USDC in Account 2 → saved done. No new account, ledger, spending permission or provider-history dependency.

## Tasks

- [x] Regressions: a saved completed native return projects returned; a completed return cannot be reopened by unavailable fresh exit checks; the minimum endpoint never calls history even with the obsolete recovery header.
- [x] Remove minimum-return history recovery and its native opt-in header; preserve durable receipt replay and first-completion verification.
- [x] Accept saved native completion directly, skip completed inventory targets and avoid reading completed journals on Home/vault focus.
- [x] Run affected and full app/backend suites, affected native tests and independent review; build and install the production app against api.gizu.io.
- [ ] After the owner unlocks the wallet, inspect the actual old record and report whether a saved terminal completion was restored. Do not claim an unrecorded historical completion was repaired.

Review focus: a later actual redemption must remain new work; unsigned cancellation must not reopen an old completed return; incomplete private returns must remain incomplete; minimum-only evidence must not authorize spending; unavailable providers must not change a saved completion.

Older records without a saved final completion cannot be silently represented as having a cryptographic receipt. This work must not fabricate one or use today's balance to reopen a completed record.

## Review and compatibility

The native reconciler also used to recheck already finalized steps against provider receipt lookups and current shares. A saved completed private return now makes its preceding finalized operations terminal for that exact chain, owner, cycle and slot. Later pending/signed operations still reconcile. The regression failed on `eth_chainId` before the change and passes without any RPC access afterward.

Independent review found one Important gap: a minimum receipt could bypass a separately pending legacy public payout. First-time UI completion now checks only the local native payout journal; it does not fetch balances, routes or a fresh exit snapshot. The min-receipt + pending-payout regression failed before correction and passes afterward.

Existing v1 full-completion observations also remain valid for the exact completed return ID. Native inventory exposes that ID, and the UI adapter restores only non-recovery `redeemed/checking` rows matching the wallet, profile, cycle and slot's recorded completed return. Later returns, later primary work and pending payouts are not hidden. This never creates a native receipt or spending authority. A focused independent review found no Critical/Important issue with this compatibility change.

## Validation

Backend: 492 total / 480 pass / 12 optional skips; TypeScript passes. Affected native suites pass. Full native suite: 566 total / 559 pass / the same seven established `EarnDepositPreparerTest` fixture failures, with their names:

- `cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview`
- `independentPayoutPreviewsOverlapBeforeTheVaultRead`
- `payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData`
- `missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation`
- `reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair`
- `slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums`
- `continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending`

These retain the documented fake-payout 0.099 USDC versus production 0.17 USDC routing floor mismatch. No floor, fixtures or spending guard was weakened.

Final JavaScript suite: 1,084 tests / 111 suites pass. Mobile/backend TypeScript and scoped ESLint/formatting pass. Final affected native suites: 41 pass. The regression for malformed completion observations failed before strict tuple validation and passes afterward.

Standalone production `assembleRelease` succeeded. DEBUG=false, native hosted mode and api.gizu.io were verified. The obsolete history-recovery header is absent from release DEX. APK `/tmp/gizu-terminal-withdrawals-release.apk` SHA256 `2eb656c16148f2f1fbd39ad7a2a761c070f043e6c9b1cef81e5724eaabb626f9`; signing certificate remains SHA256 `9b241fadf59f6bd0707b928859468c63c69b3ecb9b1060fb5a2b3a4f4bc21c67`. Samsung SM-S911B installation succeeded without clearing data; the installed APK hash matches exactly. The app opened to normal `Unlock wallet`; the owner was asked to unlock it for live historical-status inspection. No financial approval or transaction was performed.

Backend changes require the owner's merge of `feat/return-status-consistency` into main and deployment. No AWS resource was modified. Earlier plans' history-recovery recommendations are explicitly superseded.
