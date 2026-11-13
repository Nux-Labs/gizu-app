# Gizu Earn debugging and AWS session handoff

This handoff records the work through commit `d154379` on November 12, 2026
(Europe/Istanbul). It is intended to let a new session continue without repeating
the investigation or treating older implementation notes as the current state.

## Start here

- Workspace: `/Users/ouyildiz/Desktop/gizu-app`.
- Current branch: `fix/confidential-earn`.
- Current code commit: `d154379d2fea26934de1f493c625932e1d964568`.
- Local HEAD and `origin/fix/confidential-earn` matched after the last push.
- The working tree was clean before this handoff file was added. This handoff is
  a new local documentation file; it has not been committed or pushed.
- Canonical repository: `https://github.com/Nux-Labs/gizu-app`.
  The configured remote still uses `enliven17/gizu-app`; GitHub redirects it.
  Do not change the remote just to silence that notice.
- Latest tested APK is installed on the Samsung, preserving wallet storage.
- Last verified phone state: the current vault withdrawal loads, the false
  wallet-mismatch error is gone, and **Continue saved transaction** is visible.
- That withdrawal has a **signed** saved operation. Its financial continuation
  has NOT been verified by the agent. Do not interpret this handoff as evidence
  that the withdrawal, private return, or whole end-to-end flow has completed.

The most recent user-visible error was **Saved operation belongs to a different
investment wallet.** Its concrete cause was found and fixed: parsers validated
the native operation's `investmentSlot`, then omitted it from their returned
JavaScript models. Resume/cancel subsequently parsed those models again and
rejected the missing slot. The native wallet was not supposed to be changed to
work around this. All four affected operation parsers now retain the validated
slot, and wrong or missing slots still fail the original strict check.

## User requirements and operating constraints

The user is frustrated by repeated speculative patches, repeated deployments,
and having to retry a financial flow several times. Explain an actual observed
cause, make the shared fix at its source, and verify the affected adapters and
journey. An HTTP 200, a passing mock-only UI test, an APK installation, and a
successful financial transaction are different facts.

The accepted product requirements are:

1. Portfolio total is displayed in **USD**, including all owned stablecoin
   holdings and private USDC, with no double counting. USDG must not disappear
   from the total because a later read or market valuation is unavailable.
2. Show existing observations promptly. Do not give private balances a unique
   permanent “Previously checked” treatment while presenting other observations
   as if they were intrinsically current. Users can refresh explicitly.
3. Asset rows show the asset logo and value. Amounts and holding details belong
   behind the asset's detail view, not as three repeated pieces of row content.
4. Use **Refresh private balance**, not “Unlock private balance” when a saved
   private observation is already displayed.
5. Deposit screens use the same observed USDC available to the shared portfolio.
   Do not require a manual refresh before a deposit. Fresh funds/reservations
   are verified within the requested native action; observations are not signing
   authority. Show a specific insufficient-funds outcome if the funds have moved.
6. A deposit finishes when the funds are invested in the vault. It must not
   transition into withdrawal/private-return steps as though those complete it.
7. An explicitly requested vault withdrawal and its private USDC return form a
   separate journey. New exits finish privately. Making funds public is the
   separate **Withdraw from Gizu** flow. Saved legacy public payouts keep their
   original recovery policy.
8. Resume the SAME funded or converted deposit. Do not require another USDC
   conversion, create a replacement investment wallet, or hide saved progress.
9. Aurora history access is unavailable. The user contacted Aurora and explicitly
   instructed us to work without that endpoint. Do not put it back on the current
   flow's critical path or assume setting a qualification flag grants access.
10. Reuse the working wallet, Swap, native approval, gas, and settlement components
    where their actual contracts match. Do not copy a different financial policy
    merely because its UI looks similar.

Authorization and safety boundaries carried throughout this work:

- Continue on `fix/confidential-earn`; pushing fixes to that branch was requested.
  Do not switch to main, merge, or deploy as part of an ordinary follow-up.
- The user performs AWS/backend releases. **Do not change AWS settings or deploy
  through the AWS interface.** Read-only AWS inspection is authorized. If an AWS
  UI configuration change is needed, explain the exact steps for the user.
- Updating the connected Samsung with `adb install -r` is authorized. Preserve
  the wallet and native journals. Never uninstall, clear app data, reset the
  wallet, delete saved operations, or extract wallet secrets.
- Never sign, submit, rebroadcast, resume a financial transaction, approve a
  passkey ceremony, or tap a financial Confirm/Continue control on the user's
  behalf. Financial approval remains with the user.
- Read-only position navigation, journal reconciliation/status checks, existing
  read-only balance verification and provider/chain probes are authorized.
- Never log or print `.env`, API keys, credential URLs, authorization headers,
  signed payloads, wallet entropy, passkeys, or upstream exception bodies.
- User wallet authentication/unlock must be completed by the user. A reconnect
  or unlock reply does not authorize a financial approval.

## Problems encountered and what was established

### Portfolio and deposit balance inconsistencies

The user originally saw about 0.24 USDC become about 0.09, apparently losing
roughly 0.15 USDG, while private USDC was excluded from the total and shown as a
separate persistent “Previously checked” amount. Portfolio load took roughly
6–7 seconds. A generic unavailable-values banner could appear even while the
visible holdings looked complete.

The UI/portfolio work introduced prompt native cached observations, USD-valued
stablecoin handling, simplified logo/value rows and the private refresh wording.
It was pushed on `fix/UI-optimizations` and is represented by `8473e2a`, later
merged into main by PR 53. Native ownership/projection deduplication and current
amount/value completeness remain important: a missing price does not establish
a missing holding, and a duplicate public/private projection is not new money.

A later deposit-only balance verifier duplicated the portfolio's ownership and
freshness logic. It could block review with **Available USDC could not be verified.
Retry before investing.** even when Home displayed the balance. The shared-balance
fix (`34e3890`) removed the separate `useDepositFundingBalance` hook and routes
display through `MainnetWalletProvider` and `useFundingWallet`.

Current deposit cash is observed private Monad-origin USDC plus eligible public
USDC. Portfolio total and spendable deposit cash are different projections.
USDG already in a saved investment wallet is not new-deposit USDC; it must be
handled through that saved deposit's remaining steps. Explicit refresh and wallet
actions refresh shared observations, preserve old display on failed reads, and
ignore results from before an action or another wallet session. Foregrounding
alone must not create an unrelated manual balance verification gate.

### Approval stopped and the CA certificate work

The early failure appeared immediately after **Review**, before a meaningful
spending approval. Preview failures and navigation/AppState cleanup were being
reported as generic cancellation. Legitimate credential UI focus changes and
real departures needed different lifecycle treatment; a failed unsigned draft
must retain its real failure rather than be overwritten by cleanup cancellation.

There was also a real backend runtime trust problem. The final slim Docker image
did not have the OS CA roots required by the separate Anvil HTTPS process. Node's
bundled CA roots and `NODE_EXTRA_CA_CERTS` did not fix Anvil. The Docker runtime
now installs `ca-certificates`. RDS trust remains a separate CA bundle with full
TLS/hostname verification. This work is represented by `626ca70`, on
`fix/CA-certificate`, merged by PR 54. Do not “fix” this by disabling TLS checks.

The user initially requested `fix/confidential-earn`, renamed it to
`fix/CA-certificate` during certificate investigation, then asked that the
subsequent Earn flow work be moved to a separate `fix/confidential-earn`. That
separation has already happened. Do not reconstruct or rename those branches.

### Fees unavailable, changed terms and premature recovery UI

Errors included **A fresh fee estimate is unavailable. No new spending can be
approved**, **The live terms changed**, **Check failed**, and **The funding provider
is unavailable. Saved progress is preserved; review the remaining steps to retry.**
These strings were symptoms, not a single diagnosis. Several separate faults
were found over the work. Do not attribute every later error to CA, nonce, history,
or a missing balance merely because that was the preceding fault.

The coordinator, preview calculation, native grant and screen lifecycle need to
agree on reviewed amounts, source identities, fees, expiry and transaction state.
Unsigned terms can be refreshed within the actual reviewed constraints; already
signed bytes are immutable. Active settlement polling must remain inside the
current native approval instead of presenting normal receipt waits as paused
recovery requiring another review. Failure, backgrounding and expiry must not
silently reacquire spending authority. `cf5a969` records part of the shared fee
and paused-review correction.

Existing repo notes also document historical SDK compatibility failures that
illustrate the same architectural issue: direct-token paymaster signatures may
be exactly 182 or 183 bytes; final sponsorship simulation needs the installed
SDK's non-authorizing placeholder signature; final paymaster responses may omit
gas limits already present in the estimate. The native/backend parsers must
match the working SDK's real contract. These are documented historical fixes,
not a diagnosis of the most recent `Check failed`.

### History unavailable and converted USDG stranded before deposit

The user confirmed Aurora history was not available and required a history-free
implementation. Repeating balance reads or hoping history would be enabled was
not a solution. Current paths use authenticated balance baselines/deltas,
operation-scoped sealed evidence, successful saved routes, and canonical origin
or destination token-transfer receipts as appropriate.

For distribution deposits, more than one signed payout can contribute to the
same recipient. Per-child receipt guessing breaks attribution and recovery.
`d40a2e2` introduced history-free grouped delivery: immutable signed membership,
whole-recipient receipt accounting, durable anti-replay coordination, independent
native verification, and atomic persistence of the shared proof and child
allocations. The read-only group endpoint is
`POST /v1/earn/native/payout/group-status`. It does not submit funds or create
spending authority. Existing paid siblings, amounts and signed bytes stay fixed.

The user then had converted funds in USDG but no vault deposit. Saved progress
was not discoverable from the ordinary deposit entry, and the preview path still
assumed new USDC funding. `7b8dd27` restores the saved journey through the normal
Deposit action, supports already funded wallets in remaining review, and avoids
forcing the same conversion again. Use **Review remaining steps** on the saved
journey, not a fresh deposit form. Recovery must not discard funded progress.

### Proven nonce verification failure and its fix

AWS and Alchemy logs matched the failing EntryPoint 0.8
`getNonce(address,uint192)` read at **November 12, 01:36:44 Istanbul**. Alchemy
returned HTTP/JSON-RPC **429**, reporting compute-unit capacity exhaustion.
This was not a missing history record or a reason to invent a zero nonce.

The backend allowed two disposable forks, each configured for 1,000 CU/s, against
an observed 500 CU/s account allowance. Fork reads were starving the live nonce
read. `b2ef13a` fixes this at the source:

- Keep the existing maximum of two fork processes, each configured for 150 CU/s.
  Their combined configured budget is 300 CU/s per backend process.
- Use `backend/src/adapters/evm/read-transport.ts` for the qualified read-only
  paths, with up to three retries/four attempts under a 12-second whole-read
  deadline, including backoff and `Retry-After`.
- Permit only read methods. Signing, submission and fork mutation methods do not
  inherit this retry behavior. Nonce changes and all identity/freshness checks
  continue to reject unsafe execution.
- Preserve numeric positive RPC 429 in safe diagnostics.

Installed-SDK regression tests reproduced the production exception and recovered
the real nonzero fixture nonce within the same preparation call. Exhaustion is
bounded. Multiple unsigned live fork plans succeeded with the lower budget,
including controlled nonce throttling. No spending was signed/submitted by those
probes. The user later deployed this backend work.

This configured capacity is per process. Multiple replicas, rolling deployment
overlap, other applications and external account usage can still exhaust an
account-wide provider limit. The fix is not proof that 300 CU/s is safe for any
future provider plan or topology.

### Deposit opening an old withdrawal and completed return reappearing

After investing, the user saw **Step 2 of 2 Return to private balance**. Initially
the agent treated it as unfinished old withdrawal activity; the user correctly
pointed out the old return was already complete and the funds were being
redeposited. That initial inference was wrong.

`5a1b4a4` separates the non-financial position overview from the withdrawal route.
Depositing ends at the investment overview; opening it does not mount old exit
recovery. The overview's **Withdraw** control only navigates to the protected
withdrawal screen. Later **Review/Confirm/Continue** controls can be financial.

The native investment inventory intentionally reports some authenticated old
returns as `redeemed`, not final `returned`, because it cannot attest away all
remaining public assets. Treating `redeemed` as “must return again” was wrong.
The existing read-only exit verifier confirmed the old return's credit and
negligible residual, even though the current private balance had already been
spent/redeposited. Historical completion must not require that old private money
to remain in the account.

`757a614` recognises completed old exits before selecting the current investment.
Repeated entry then exposed an operational error being interpreted as an
unfinished return; `891492e` separates valid pending journal activity from failed
verification reads. A failed check shows status unavailability, not a fabricated
unfinished-return state.

Completion was still stored only in component memory and lost on remount.
`360d5ab` persists a non-secret completion observation in
`mobile/src/storage/completedExits.ts`, scoped by wallet/profile/intent/slot and
matched against native operation and legacy payout revision/status sets. Each
new visit rereads the native journals. New, changed, pending or recovery activity
defeats the observation. A first unrecorded completion still uses the existing
fresh public state/receipt verification. **Check past withdrawals** forgets the
observation before a fresh read, keeping later gifts/residuals recoverable.

The observation never authorizes spending or removes holdings from portfolio
discovery. The device passed repeat openings and background/resume with the old
return remaining completed and the current investment selected at Step 1.

### Separate intermittent live price verification failure

An actual historical `/v1/earn/exit-snapshot` HTTP 500 was matched at
**November 12, 11:26:40 Istanbul**, request `req-38y`. Provider logs showed all
13 preceding chain reads succeeded, with valid contract metadata, a fresh block,
zero shares and zero native/wrapped balances. The final canonical block reread
was absent. Source ordering narrowed the failure to live price retrieval or
validation. The backend discarded its exact exception.

Further pre-instrumentation failures occurred at 12:20 and 12:21 (`req-3j9`,
`req-3jn`). A read-only retry passed at 12:22 and established the durable old-exit
observation. Direct contemporaneous Aurora token registry probes passed the
existing USDG/USDC metadata and five-minute price-age validation. That does not
prove what happened in the earlier failed request.

**Do not claim this historical failure was nonce throttling, CA failure, a stale
price, a future timestamp, or a historical block problem. None was established
for this request.** A sample public RPC Cloudflare denial is not evidence about
the owned production RPC. Provider log response previews can truncate block
fields; an absent timestamp in that preview was not a malformed actual response.

After the user explicitly requested useful logs, `a8428c5` added structured safe
failure diagnostics without changing the public response or acceptance policy:

- `backend/src/adapters/earn/exit-snapshot-error.ts` classifies fixed stages and
  reasons and allowlisted transport/TLS/SDK codes plus numeric HTTP/RPC codes.
- `exit-snapshot.ts` retains price-provider status on fetch/body/JSON failures
  and asset/age metadata on price validation failure.
- `backend/src/http/map-request-error.ts` attaches `exitSnapshot` to the existing
  request-correlated `private.error` log. No raw cause, URL, body, wallet, balance,
  price, header, or stack is serialized.

The user deployed it. The next observed exit snapshots returned HTTP 200 at
**13:07:55** and **13:09:05**; withdrawal plans returned HTTP 200 at **13:08:01**
and **13:08:39**. No new `exitSnapshot` failure was present then. A later read-only
refresh during the wallet-slot investigation also found no `private.error` in
the selected last-hour window. Those successful server responses did not prove
the native transaction completed; the user still reported **Check failed**.

The historical price-stage failure remains unresolved until it recurs with the
new diagnostics. Do not manufacture a cause or add speculative retries/change
price freshness just to declare it fixed.

### Latest wallet-slot rejection

On reopening, the user saw **Saved operation belongs to a different investment
wallet.** The exact string comes from
`mobile/src/domain/earn/distribution.ts:assertInvestmentSlot`.

The native sponsored journal exports `investmentSlot`. The JavaScript
`parseSponsoredOperations` checked it, then returned a `SponsoredOperation`
without it. `createEarnRobinhoodService` validates the normalized operation again
before resume, cancellation or settlement, so a correct operation now looked
unbound. The same omission existed in the Ethereum liquidity, Ethereum vault,
and private payout parsers.

`d154379` adds the optional field to all four operation types and retains its
already validated raw value. It does not derive a missing slot from UI state or
remove `assertInvestmentSlot`. Four parser round-trip cases and a real-service
navigation regression failed before the fix. All 999 mobile tests pass after it.

The update is installed and was inspected after the user unlocked. The error is
gone and **Continue saved transaction** is displayed. The latest native activity
showed **Vault withdrawal · signed**, with the investment still displayed. Do
not infer definite submission, definitive non-submission or settlement from that
label. No financial Continue/Confirm was pressed by the agent. The earlier
generic **Check failed** may have a separate native cause; that has not been
captured or proved fixed by retaining the slot.

## Shared architecture and why repeated work broke consistency

These are specific observations and recommendations for the next session, not
permission to replace the app architecture wholesale.

| Area                                       | Repeated work or incompatible assumption                                                          | Result                                                                                                  | Required shared handling                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portfolio versus deposit                   | Separate available-balance fetching, caches and freshness gates                                   | Home shows funds while Deposit refuses them                                                             | Keep portfolio observations under one wallet-scoped owner; derive deposit cash from it; validate real spend inside native action                                                                      |
| Balances versus prices                     | A price expiry or failed price read treated as missing balance                                    | Totals shrink; generic unavailable states mislead                                                       | Preserve quantities/observations; track valuation completeness independently; apply documented stablecoin fallback consistently                                                                       |
| Portfolio pricing versus exit verification | `portfolioValuation.ts` calls the full exit-snapshot route to obtain prices                       | Ordinary valuation repeats investment-wallet chain/contract/canonical work and shares exit availability | A future price-only adapter/cache should reuse the authoritative public price validation without copying balances or weakening exit verification; design and test the contract before changing routes |
| Historical completion versus live state    | Re-run fresh price/balance verification on every historical exit opening                          | Remount or provider failure resurrects an already finished flow                                         | Persist only verified historical presentation evidence, rebind to native revisions, retain explicit residual recovery; never cache spending authority                                                 |
| Overview versus execution                  | One position screen mounts withdrawal execution/recovery after deposit                            | A new deposit appears to require returning funds                                                        | Keep overview read-only; mount exit orchestration only on explicit withdrawal navigation                                                                                                              |
| Journal readers                            | Selection, `useEarnJournal`, and final exit panel can each list/reconcile the same native journal | Extra provider work and potential busy/stale result conflicts                                           | Define who owns each read; serialize native mutations/selection and share compatible observations; keep generation/abort guards                                                                       |
| Journal identity                           | Native export, TS types and normalized models disagree                                            | Correct saved operations fail later strict binding                                                      | Parser output must remain valid on revalidation; preserve slot/cycle/operation/revision identity where the contract requires it; test real adapter round trips                                        |
| Lifecycle versus error state               | Screen cleanup, AppState and credential focus changes overwrite real stop causes                  | “Approval stopped” hides preview/provider failure; retries become brittle                               | Retain the first meaningful failure and saved external progress; cancel only live unsigned authority; distinguish real departures from bounded credential UI                                          |
| Normal settlement versus recovery          | Polling reports every missing receipt as paused                                                   | User must repeatedly review normal waiting steps                                                        | Existing native host continues within its active bounded grant; recovery is for actual pause, expiry or uncertainty                                                                                   |
| Gas/sponsorship                            | Independent paymaster parsers and hand-built simulation requests diverge from SDK                 | Working Swap and broken Earn on the same provider                                                       | Reuse qualified transport/decoder conventions and shared gas policy; keep signed packets immutable and submission retries separate                                                                    |
| RPC capacity                               | Each fork consumes budget independently from ordinary reads                                       | Simulator traffic starves nonce/receipt reads                                                           | Bound aggregate fork capacity and logical read deadlines; include deployment overlap/replicas in account-wide budget                                                                                  |
| History and payout attribution             | Each child guesses destination receipts or assumes history access                                 | Shared recipients and batched transfers cannot be attributed safely                                     | Reuse immutable group membership, canonical whole-recipient proofs, durable anti-replay claims and atomic native persistence                                                                          |
| Error handling                             | Generic catches discard stage/cause, cleanup changes labels, HTTP status is treated as outcome    | Repeated diagnostic releases and wrong hypotheses                                                       | Keep safe causal codes/stages/reqId across layers, distinguish HTTP/JSON-RPC/native/chain/settlement outcomes, redact at logging boundaries                                                           |
| Test boundaries                            | Functional tests mock the entire Earn service and use legacy intents without slots                | Real service normalization/identity bugs remain invisible despite a green screen suite                  | Mock native/network/persistence boundaries; use real parsers/adapters/controllers/navigation for distributed saved-operation journeys                                                                 |

Practical rules for subsequent fixes:

1. Trace one attempt across display observation, requested action, native journal,
   backend request, provider result, signed/submitted state and final settlement.
   Do not collapse these into one `loading`/`error` or `complete` Boolean.
2. Keep the common providers and existing domain services as owners. Do not add
   another screen-specific balance hook or another detached recovery coordinator.
3. Cache balances for display under wallet/session identity. Cache reusable public
   prices independently with their actual expiry. Keep historical completion
   evidence independent of current private holdings. Keep signing terms fresh.
4. A strict guard often reveals a malformed upstream model. Fix the model rather
   than relaxing the guard or filling identity from the currently selected wallet.
5. Native journals, receipts and reservations remain the authority. UI cancellation
   cannot unsend a transaction. Reading status must never rebroadcast it.
6. Shared gas policy is in `shared/gas-policy-v1.json`; use existing qualified
   native/backend gas components rather than divergent constants or estimates.
7. Similar Swap presentation is useful; Swap's historical route-success/minimum
   fallback on an authenticated balance 401 is a different financial policy.
   Do not silently copy it into Earn's operation-scoped settlement verification.
8. Native current-cycle/current-slot selection is mutable state. Preserve the
   existing ceremony serialization and stale-result protection. A new race here
   is an audit concern, not a proven cause of the just-fixed slot omission.
9. A green test suite does not establish passkey behavior, foreground lifecycle,
   provider availability, real on-chain settlement, or iOS acceptance. State the
   verification boundary honestly.

## Current source map

| Responsibility                                             | Main files                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared observations and refresh sequencing                 | `mobile/src/features/wallet/MainnetWalletProvider.tsx`, `WalletProvider.tsx` / `useFundingWallet`                                                     |
| Canonical total, stablecoin fallback and deposit cash      | `mobile/src/domain/wallet/portfolioValue.ts`                                                                                                          |
| USDG valuation and existing exit-snapshot price dependency | `mobile/src/services/wallet/portfolioValuation.ts`                                                                                                    |
| Portfolio UI                                               | `mobile/src/features/wallet/MainnetScreens.tsx`, `PortfolioAssetRow.tsx`, asset detail screen                                                         |
| Deposit UI and lifecycle                                   | `mobile/src/features/earn/DepositJourneyScreen.tsx`, `useDepositJourney.ts`                                                                           |
| Earn ownership and native position selection               | `mobile/src/features/earn/EarnProvider.tsx`, `useVaultPosition.ts`, `mobile/src/services/wallet/investmentPositions.ts`                               |
| Overview versus withdrawal routes                          | `VaultPositionScreen.tsx`, `VaultWithdrawalScreen.tsx`, `RobinhoodWithdrawalPanel.tsx`                                                                |
| Journal orchestration                                      | `mobile/src/features/earn/useEarnJournal.ts`                                                                                                          |
| Slot validation and normalized models                      | `mobile/src/domain/earn/distribution.ts`, `sourceFunding.ts`, `ethereumLiquidity.ts`, `vaultExecution.ts`, `withdrawal.ts`                            |
| Revalidating operation services                            | `mobile/src/services/earn/robinhoodExecution.ts`, `ethereumLiquidity.ts`, `vaultExecution.ts`, `withdrawal.ts`                                        |
| Exit evidence and final panel                              | `mobile/src/domain/earn/exitCompletion.ts`, `mobile/src/services/earn/exitCompletion.ts`, `ExitCompletionPanel.tsx`                                   |
| Historical completion observations                         | `mobile/src/storage/completedExits.ts`                                                                                                                |
| Native bridge and ceremony boundary                        | `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/GizuStoredSignerModule.kt`                                              |
| Native current cycle/slot filtering                        | `.../storedwallet/OwnedAccounts.kt` / `currentCycleRows`                                                                                              |
| Native deposits and recovery                               | `.../storedwallet/earn/EarnDepositCoordinator.kt`, `EarnDepositPreparer.kt`, `EarnDepositRemaining.kt`, `EarnDepositJournal.kt`, `EarnDepositHost.kt` |
| Native sponsored execution and public journal              | `.../storedwallet/earn/EarnSponsoredEngine.kt`, `EarnSponsoredJournal.kt`, `EarnSponsoredReconciler.kt`                                               |
| History-free payout grouping                               | Native `EarnPayoutGroup.kt` / `EarnPayoutJournal.kt`; backend `earn-payout-group.ts`, `private-payout.ts`, PostgreSQL coordination                    |
| Backend fee/convergence/simulation                         | `backend/src/adapters/earn/robinhood-paymaster.ts`, `robinhood-simulation.ts`, `fork-simulation.ts`                                                   |
| Read-only retry policy                                     | `backend/src/adapters/evm/read-transport.ts`                                                                                                          |
| Backend safe diagnostics                                   | `robinhood-plan-error.ts`, `exit-snapshot-error.ts`, `backend/src/http/map-request-error.ts`                                                          |
| Price/exit snapshot                                        | `backend/src/adapters/earn/exit-snapshot.ts`, `backend/src/http/routes/earn-exit.routes.ts`                                                           |
| Backend native gateway                                     | `backend/src/adapters/earn/native-gateway.ts`, `backend/src/http/routes/earn-native.routes.ts`                                                        |

All paths in this table are relative to the workspace. Read `mobile/AGENTS.md`
before editing mobile code. It requires functional journey coverage using real
screens/controllers with external-boundary mocks and no secrets in JavaScript.
The requested LOR/Context7 capabilities were not available in the tool inventory
used during this work; do not pretend those tools were called.

## AWS setup and what is actually known

The current backend is **AWS ECS**, not Render. The primary maintained guide is
`docs/app-guide/AWS_BACKEND_DEPLOYMENT.md`. Many dated sections in
`CONFIDENTIAL_EARN.md` refer to old Render endpoints and old test totals; they
are historical context. `docs/feature-plans/AWS_DEPLOYMENT_PLAN.md` contains a
historical Lightsail proposal that was not the deployed backend architecture.
Do not use that proposal to describe or modify the running service.

### Observed AWS identifiers

| Item                                   | Last observed value                                            | Evidence scope                                        |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Account                                | `381673247521`                                                 | Console and checked-in buildspec                      |
| Region                                 | `eu-central-1` / Frankfurt                                     | Console                                               |
| ECS cluster                            | `gizu`                                                         | Console                                               |
| ECS service                            | `gizu-backend`                                                 | Console                                               |
| Task definition family                 | `gizu-backend`                                                 | Console                                               |
| Last observed task definition revision | `gizu-backend:13`                                              | After the user's diagnostics deployment               |
| Last observed running task             | `155f96c79a4949a99144c8313d60ba4b`                             | Revision 13 logs; started about 12:45 Istanbul Nov 12 |
| Earlier task                           | `f95466cddb3f411d82325b85626719b1`                             | Revision 12; contains the historical price failures   |
| Desired/running count                  | 1 desired, 1 running, 0 pending                                | Last observed service overview                        |
| Deployment status                      | Success                                                        | Last observed service overview                        |
| Log group                              | `/ecs/gizu-backend`                                            | ECS “View in CloudWatch” link                         |
| ECR repository                         | `gizu-backend`                                                 | Buildspec/guide                                       |
| ECR URI                                | `381673247521.dkr.ecr.eu-central-1.amazonaws.com/gizu-backend` | Buildspec                                             |
| API                                    | `https://api.gizu.io`                                          | Current integration configuration/docs                |
| CodeBuild project                      | `gizu-backend-build`                                           | Maintained release guide                              |
| CodePipeline                           | `gizu-backend`                                                 | Maintained release guide/user release workflow        |

These are a session snapshot, not a live inventory assertion for a later day.
Exact ALB, target group, certificate ARN, VPC/subnet/security-group IDs, RDS
instance identifier/endpoint, secret ARNs, bucket name and role ARNs were not
captured in this investigation. Do not invent them. The guide documents the
required topology; some sizes/settings below are documented starting settings,
not independently verified runtime values.

### Deployment components and responsibilities

1. **GitHub source / CodePipeline.** The guide's source branch is `main`, through
   a GitHub App connection. Automatic source triggers are disabled; the user
   chooses **Release change**. Verify the actual pipeline source revision when
   diagnosing “deployed” code. A local branch push alone is not a backend release.
   Do not assume current `main` contains `fix/confidential-earn`, or merge it
   without instruction. During this session the user reported releases and new
   ECS tasks were observed; the actual image/source commit should be checked for
   any future uncertain deployment.
2. **CodeBuild.** Project `gizu-backend-build` uses `backend/buildspec.yml` with
   repository-root Docker context. Documented environment is Amazon Linux
   `aws/codebuild/amazonlinux-x86_64-standard:6.0`, EC2 Linux x86_64, privileged
   Docker mode, initially small compute, outside the application VPC. After
   pipeline integration, its source/artifact types are CodePipeline. Production
   provider/database secrets do not belong in this build.
3. **ECR.** Private image repository with immutable tags. Buildspec tags images
   with first 12 commit characters plus CodeBuild UUID and applies an OCI full
   commit label. It builds `linux/amd64`, smoke-tests the exact image, pushes only
   after successful checks, then emits `imagedefinitions.json` for container
   `gizu-backend`. Rerunning an old stage is not fetching the latest source.
4. **ECS Fargate.** Documented task OS/architecture is Linux/X86_64, container
   `gizu-backend`, port 3000/TCP, starting size 1 vCPU/4 GiB, one desired task and
   autoscaling initially disabled. The exact active CPU/memory and autoscaling
   policy should be checked before treating these guide defaults as observed.
5. **ALB and HTTPS.** The guide configures HTTPS `api.gizu.io` in front of the
   backend and health check `/v1/health`. Preserve the application's single-proxy
   client-IP trust assumption. The ALB security group reaches backend TCP 3000.
6. **RDS PostgreSQL.** The documented backend DB is PostgreSQL 18 in the same VPC,
   reachable only through the appropriate backend/database SG rule on TCP 5432.
   App pool: max 10, connection timeout 2 s, idle timeout 30 s, statement timeout
   5 s; session timezone UTC. A pg deprecation warning about overlapping
   `client.query()` calls was observed at startup, but was not established as a
   cause of the Earn failures. An empty RDS instance is not a migration of old
   Render recovery/coordination data.
7. **Secrets Manager and IAM.** Task execution role needs scoped ECR pull,
   CloudWatch logging and referenced secret-read permissions. CodeBuild needs
   scoped ECR push/logging and pipeline artifact access, not production-secret
   access. Pipeline role needs GitHub connection, CodeBuild, artifact bucket,
   ECS update/task-definition registration and limited pass-role permissions.
8. **Pipeline S3 artifacts / optional KMS.** CodePipeline source/build outputs
   use its artifact bucket. CodeBuild needs GetObject/GetObjectVersion/PutObject
   on objects and GetBucketLocation. A customer-managed KMS key additionally
   requires the appropriate decrypt/encrypt/data-key permissions. The actual
   bucket and key identifiers were not recorded.
9. **Outbound networking.** The backend must reach Aurora, Pimlico, Alchemy/chain
   RPCs, ECR, logs and secrets. The guide allows explicit public-subnet outbound
   access or private-subnet NAT/endpoints. The specific deployed subnet/NAT
   arrangement was not independently recorded; being in a subnet alone does not
   prove egress works.
10. **CloudWatch.** Runtime requests/errors are visible in ECS service Logs and
    `/ecs/gizu-backend`. CodeBuild has separate build logs. Request diagnostics
    must be correlated with the correct task/revision and user attempt time.

### Runtime image, TLS and shutdown

`backend/Dockerfile` uses Node `24.19.0-bookworm` to build and
`24.19.0-bookworm-slim` to run. It installs dependencies, runs backend typecheck
and tests, installs pinned Linux AMD64 Anvil 1.8.3, compiles TypeScript and prunes
development dependencies. The final process runs as user `node`, exposes 3000,
and starts `node dist/server.js`.

Defaults packaged in the runtime:

```text
NODE_ENV=production
PORT=3000
EARN_ANVIL_PATH=/app/backend/.runtime/anvil-v1.8.3/anvil-fork
NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
```

The runtime installs Debian `ca-certificates` for Anvil's HTTPS trust and copies
the official RDS global bundle for Node/pg. `DATABASE_URL` uses the RDS DNS name,
URL-encoded credentials, database `gizu` and `sslmode=verify-full`. RDS's generated
master secret is not by itself the complete application connection string.
Preserve TLS and hostname verification. Secret changes require a replacement
task to reach its environment; merely editing a secret does not mutate a running
process's environment.

SIGTERM/SIGINT stop new work, drain active HTTP requests and close resources.
Responses finishing during drain close HTTP/1 connections. The shutdown deadline
is 20 seconds, leaving margin inside the documented ECS 30-second stop timeout;
errors or deadline exhaustion exit nonzero. Keep stop timeout at least 30 seconds.
Do not confuse the Anvil build task named `build:render` with a current Render
deployment; that npm script name is historical.

The container smoke script uses disposable PostgreSQL 18 on an internal Docker
network with dummy credentials and no published ports. It verifies health,
non-root runtime, Anvil wrapper, both CA bundles and SIGTERM exit before image
publication. It does not test live RDS TLS, funded simulation or financial success.

### Configuration names only

Use `backend/src/env.schema.ts` as the schema. Required runtime configuration
includes `DATABASE_URL`, `ONEINCH_API_KEY`, `AURORA_API_KEY`, `PIMLICO_API_KEY`,
`NODE_ENV`, and `PORT`. Relevant optional settings include:

- `ETHEREUM_RPC_URL`, `ROBINHOOD_RPC_URL` (qualified HTTPS RPC endpoints).
- `EARN_GATEWAY_RECOVERY_KEY` (64 hex characters; preserve its existing value).
- `EARN_ANVIL_PATH`.
- `EARN_AURORA_FEE_QUALIFICATION_JSON` for an explicitly qualified fee override.
- `EARN_AURORA_HISTORY_QUALIFIED` for legacy admission only; current native
  balance-delta settlement must not depend on it being true.
- Recovery upload/storage capacity settings and catalog chain/vault overrides.

Never print their secret values. The locally inspected Robinhood RPC host was
the user's Alchemy endpoint. Provider keys stay on the backend; the app uses
`EXPO_PUBLIC_API_URL=https://api.gizu.io`. Frontend hosting and its `VITE_API_URL`
are separate from this mobile/backend handoff. The landing S3/CloudFront work is
also a separate deployment, not this backend's runtime.

Preserve recovery keys and DB coordination/recovery data across releases.
Quotes, simulation admission and some caches are process-local. One desired task
does not prevent old/new task overlap in a rolling deployment. Plan draining or
shared coordination before assuming an in-flight quote will survive replacement.

## Reading useful diagnostics

AWS console link used for this session:

```text
https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/gizu/services/gizu-backend/logs?region=eu-central-1
```

For a fresh failure, record the user's Istanbul timestamp, route, task and `reqId`.
Filter `private.error`, or the specific route. Do not mistake old task-12 errors
for new task-13 failures. `private.request` records HTTP status and elapsed time;
`private.error` may include:

- `planning`: funded Robinhood plan stage/reason, bounded HTTP/RPC codes,
  allowlisted SDK types, AA validation code, selected source-module location.
- `exitSnapshot`: request validation, chain read, reference validation, price
  fetch, price validation, canonical check, valuation or freshness stage; fixed
  reason; HTTP/RPC/TLS/network code; token/usdc/native asset and price age if
  available. For example, `price-expired` with `priceAgeMs > 300000` establishes
  stale pricing. That is an interpretation rule, not the historical diagnosis.

Price fetch HTTP status is retained even if JSON/body parsing fails. A transport
failure can have no HTTP status. A provider error in a successful HTTP envelope
or a client/native validation failure can still stop a journey after HTTP 200.
Read the matching native outcome rather than changing fees based on status alone.

Native diagnostic tags:

- `GizuWallet`: native ceremony code/location.
- `GizuEarnDeposit`: preparation/execution stop stage/code/location.
- `GizuRpc`: service/method/numeric failure classification where available.
- `GizuSettlement`: bounded saved settlement read facts.

The most recent captured error-only log buffer retained only
`JobCancellationException at unknown`; it did not establish the original generic
`Check failed` cause. Android buffers can lose older attempts. Capture one fresh
user-operated attempt with timing, without logging keys, signatures or raw
provider bodies. Do not clear wallet data to obtain a cleaner reproduction.

## Device setup and read-only verification

```text
ADB=/Users/ouyildiz/Library/Android/sdk/platform-tools/adb
Samsung serial=RFCWA0F5SAN
Model=SM_S911B
Package=com.example.gizu.dev
Activity=io.gizu.android.MainActivity
App version=0.5.2, versionCode=11
```

USB visibility is intermittent. Check `adb devices -l` before requesting a
reconnect; the sandbox can prevent the ADB daemon from binding, so distinguish a
sandbox permission failure from an actually disconnected phone. The user has
already allowed USB debugging. Never use uninstall or `pm clear`.

Last APK:

```text
/private/tmp/gizu-operation-slot.apk
SHA256 cf2334ee86e8681fb72cb42b813fd8fc46d66940efcbd471e3818cbe19b7d9a2
```

Replacement installation succeeded with `adb install -r`. The user unlocked it.
Read-only navigation verified the saved withdrawal screen and enabled
**Continue saved transaction** without the slot error. The last screenshot is
`/private/tmp/gizu-slot-verified.png`. It also showed **Current value unavailable**;
this display alone does not prove a new backend pricing failure. The native
portfolio still rendered the vault holding. No financial Continue was tapped.

Navigation: Home's **Your vaults** card opens the position overview. The overview
**Withdraw** button is confirmed in source to navigate only. On the withdrawal
screen, **Review**, **Confirm**, **Continue saved transaction**, passkey approval,
or exact-byte rebroadcast are financial boundaries and remain with the user.
**Activity details** is read-only. Ordinary status reconciliation must not send.

`uiautomator dump` often fails to become idle due to animated UI, sometimes with
exit status zero and stale XML left on the device. Do not trust that XML. Use
fresh screenshots. Screenshots are 1080×2340; tool previews were often resized
to 945×2048, so do not reuse preview coordinates as device coordinates. Read the
current screen after each navigation; do not blindly repeat old taps.

## Commit and verification ledger

| Commit    | Purpose                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `8473e2a` | Portfolio balance/value/UI optimization, on UI branch and merged by PR 53 |
| `626ca70` | Anvil/system TLS trust and preserve review failures, CA branch/PR 54      |
| `cf5a969` | Align private funding fees and preserve paused review causes              |
| `34e3890` | Shared observed balance ownership across funding/action flows             |
| `d40a2e2` | History-free vault funding and grouped payout evidence                    |
| `7b8dd27` | Restore converted deposit progress and preview already funded wallets     |
| `2d06a42` | Safe funded vault plan diagnostics                                        |
| `e77b54c` | Sponsorship validation classification                                     |
| `b2ef13a` | Actual fork-load/nonce throttling fix                                     |
| `5a1b4a4` | Deposit ends at investment overview, separate withdrawal route            |
| `757a614` | Recognise completed old returns before selecting next withdrawal          |
| `891492e` | Distinguish unavailable verification from genuinely pending return        |
| `360d5ab` | Durable, revision-bound verified completion observations                  |
| `a8428c5` | Safe detailed exit-snapshot failure diagnostics                           |
| `d154379` | Preserve investmentSlot through all four normalized operation models      |

Latest mobile verification (`d154379`):

- Five regressions failed before the change: four round-trip parser cases and
  the real-service saved-review functional journey.
- 76 affected tests passed after the fix.
- Full coverage suite: **999 tests, 107 suites, all passed**, coverage thresholds
  passed. Log: `/private/tmp/gizu-slot-coverage.log`.
- Typecheck, full lint, full formatting and pre-commit checks passed.
- Android release assembly passed in 24 seconds. No native source was changed by
  this final parser fix. Do not claim a new full native test run for that commit.
- Independent read-only review found no substantive issue.
- APK replacement and read-only device loading verified; no financial execution
  acceptance performed by the agent.

Latest backend diagnostics verification (`a8428c5`):

- Typecheck/build passed.
- Full suite: **474 total; 462 passed; 12 skipped; no failures**. Skips were
  optional live-fork/disposable-PostgreSQL checks without their explicit inputs.
- First sandboxed run could not execute local shutdown/child-process tests.
  The complete rerun outside the sandbox passed; do not confuse those environment
  failures with an unresolved product regression.
- Safe logs/response redaction were checked through the real Fastify error mapper;
  transport tests covered HTTP 503, malformed HTTP-200 JSON, TLS causes, unknown
  sensitive error codes, numeric RPC/HTTP throttling and stale price metadata.
- User deployed it; exact historical price exception has not recurred in the
  newly inspected logs. No claim of a fixed price provider is justified.

Earlier nonce-fix validation (`b2ef13a`) ran 471 backend tests, 468 passed and
3 optional skips, plus unsigned live simulation checks. Different counts/skips
reflect different test sets and configured optional DB tests, not a promise that
every historical integration test ran in the latest diagnostics pass.

Do not claim `npm run check` is fully green: Expo Doctor's online checks were
previously blocked by automatic approval review for metadata transmission.
Types/lint/format/coverage were executed separately. Do not bypass that rejection.
iOS was not built or financially accepted in this session. Old docs' iOS/Pods
and Expo Doctor results are historical and should not be reused as current proof.

Useful commands from this workspace:

```sh
# JavaScript validation, from mobile/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run format:check
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:coverage

# Android build, from mobile/android/
JAVA_HOME=/opt/homebrew/opt/openjdk@17 \
ANDROID_HOME=/Users/ouyildiz/Library/Android/sdk \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
./gradlew :app:assembleRelease --console=plain

# Backend validation, from backend/
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
```

ADB and Gradle cache access may need the normal sandbox escalation. Explain a
concrete automatic approval rejection if one occurs; do not repeatedly ask for
permission for already authorized installation/read-only work.

## Next session priorities

1. Read this handoff, check branch/HEAD/status, then inspect the actual current
   phone state. Do not reapply fixes already at `d154379` or reconstruct branches.
2. The slot normalization fault is fixed. The existing signed withdrawal remains
   authoritative. If the user chooses to continue it, capture its fresh native
   diagnostics and matching server timestamps. The agent must stop before the
   financial control/approval; the user operates that step.
3. If **Check failed** recurs, use the exact native source location and saved
   state. Do not assume the old CA/nonce/history/price problem, discard the signed
   operation, or create a new withdrawal to make the UI move forward.
4. If a live price failure recurs, read `private.error.exitSnapshot` on the new
   task. The new stage/reason/age/transport facts should distinguish expired
   prices, registry validation, HTTP/body/JSON errors, TLS/network failure, or
   another stage. Diagnose that evidence before modifying provider policy.
5. Keep the shared-component corrections above. The user wants consistent app
   behavior and a reliable first requested action, not another isolated hook,
   contradictory error label, mandatory refresh, or parallel execution flow.
6. Deployment remains the user's job. Report which commit needs a backend
   release versus an APK update. The final slot fix is app-only; it needs no
   backend redeploy. A pushed branch is not evidence of a production release.

Relevant longer references: `docs/internal/CONFIDENTIAL_EARN.md`,
`docs/internal/CONFIDENTIAL_WITHDRAWALS.md`,
`docs/app-guide/AWS_BACKEND_DEPLOYMENT.md`,
`docs/superpowers/plans/2026-11-11-history-free-earn-delivery.md`,
`docs/superpowers/plans/2026-11-12-earn-rpc-throttling.md`, and
`docs/superpowers/plans/2026-11-12-completed-withdrawal-selection.md`.
