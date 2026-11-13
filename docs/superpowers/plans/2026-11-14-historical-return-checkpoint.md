# Historical return checkpoint correction

The owner received the historical private USDC, but its final checkpoint was never saved. The terminal-receipt fix cannot manufacture that missing financial evidence. Home and the vault must share one durable lifecycle decision while preserving the current investment and any later withdrawal.

## Implementation

- The history screen offers an explicit owner report only for a finalized Robinhood return without pending primary, return or payout work. It cannot execute or resume a transaction.
- Native code validates the saved quote/deposit binding, requires the existing supported Aurora status endpoint to report SUCCESS, reads public vault shares, and rechecks wallet generation, active cycle, foreground state and the private-read session before writing atomically at the expected journal revision.
- The encrypted lifecycle record binds the wallet, generation, operation ID, full proposal, state binding and canonical transaction hash. It says owner-confirmed, provider SUCCESS and spendingAuthorized=false. It never becomes a minimum-return receipt, credited amount or authenticated payout source.
- Provider SUCCESS closes the old incoming route for serialization. An owner report alone cannot bypass the incoming-route gate. Published SUCCESS semantics mean delivery to the destination; this retains the existing protocol assumption that subsequent authenticated balance reads reflect delivery. The balance API has no independent read-after-write watermark, so this is not a cryptographic amount proof.
- Investment holdings and withdrawal completion are separate. An invested remainder stays invested and gets a new withdrawal review scoped after the old return. A later signed/pending operation remains visible and blocks correction. A one-time empty public vault observation can resolve missing historical residual-share metadata without treating the current private balance as evidence for an old return.
- Valid records remain terminal through focus/reconciliation and encrypted history recovery. No provider history endpoint is used; spending approvals and exact/minimum credit validators are unchanged.

## Review and regressions

Independent review rejected an owner-only sequencing bypass; the implementation instead requires native-recorded provider SUCCESS. Review also found that an invested row's completed history could disappear. The separate withdrawalComplete projection fixes that case and retains its new withdrawal controls.

Regression coverage checks no financial execution from correction; no manufactured credit; provider PROCESSING/owner-only/missing-context rejection; wallet/generation/transaction/proposal tampering; encrypted recovery; later pending work; and an invested remainder opening a new review after its completed past return. The new-flow regression failed before the scoped-row correction, and the route-order regression failed before the explicit provider-terminal rule.

The first live correction failed closed because its new public share read passed an already-built JSONArray to the vararg text helper, nesting JSON-RPC parameters. The dedicated boundary regression reproduces that failure (one parameter instead of two). The correction uses the existing call API with flat parameters and tests both empty and nonzero vault shares.

## Validation

Focused UI: 70 pass. Final focused native, including the RPC parameter regression and minimum-return suite: 59 pass. Final full native: 570 total / 563 pass / the same seven existing EarnDepositPreparerTest fixture failures listed in the companion plan. TypeScript, scoped ESLint/Prettier and Kotlin formatting pass. The focused final independent review found no new Critical or Important issue.

Standalone production assembleRelease succeeds with DEBUG=false, native hosted mode and api.gizu.io. Final APK `/tmp/gizu-historical-checkpoint-release.apk` SHA256 `b797feebc058a61353195545605e5506e13269b77ad3f8b7a4ad6f0c5d972e6f`; the signing certificate matches the installed app's existing certificate. Installation succeeded without clearing data and the installed APK hash matches. The historical correction succeeded on the device: Past returns complete; private USDC remains 0.142172; the vault overview has no past-return warning and retains 1.462806 USDG deposited. No financial signing or submission occurred.

Home also clears the false return warning and retains both balances after navigating back from the vault and after backgrounding/reopening Gizu. The app is left open on Home. This is a live navigation/background check, not a new live withdrawal or process-death test.

Full JavaScript suite: 1,087 tests / 111 suites pass. Earlier terminal-receipt validation remains recorded in the companion plan. This mobile correction uses the already deployed supported status route and adds no backend endpoint. The earlier feature-branch backend removal of history recovery still requires the owner's normal main merge/deployment.
