# Confidential Earn integration

Reviewed against `main` source on 14 November 2026. This is the current app
integration reference. The [research handover](../../research/confidential-earn/APP-INTEGRATION-HANDOVER.md)
retains the original fee/economic rationale and dated experiment evidence; its
old 10/90 split, private-account and full-exit assumptions do not override this
reference or native validation.

## User actions

A deposit ends when the selected funds are invested in the vault. Any redemption
simulated during preparation runs only in a disposable backend fork to estimate
fees/reserves; it does not withdraw the live investment. The position overview
does not mount withdrawal recovery or select an old return as the next deposit
step. A withdrawal starts only from a deliberate **Withdraw** action.

On Android, a Robinhood withdrawal accepts a USDG amount before fees or **Max**.
The request is allocated across the saved investment wallets; unselected shares
remain invested. Its sequence is vault redemption, public USDG, and private USDC
in Account 2. The shared four-stage ladder reports redemption, quote readiness,
origin transfer and private receipt. **Funds received** requires the saved native
minimum-credit receipt, not just provider SUCCESS or zero vault shares. Detailed
portion, fee, retry and historical correction contracts are in
[confidential withdrawals](CONFIDENTIAL_WITHDRAWALS.md#requested-robinhood-vault-withdrawals).

Completed native returns stay complete after the USDC is spent or reinvested.
Opening Home or Withdraw does not recheck a terminal return's current balance,
prices, route or history. A completed requested portion does not mark an invested
remainder as fully exited. Home and vault details use the same native lifecycle
projection; invested balances and previous-withdrawal completion are separate.
Genuinely pending operations and saved legacy public payouts retain recovery.

A refund leaves public USDG in its investment wallet. The screen shows **Aurora
returned your funds. You can try again.** with available USDG and a deliberate
private-return retry. Retry quotes against the original redemption proceeds;
it does not redeem the vault again and requires fresh confirmation/approval.
Refund observations are terminal for origin reconciliation, never private credit.

**Withdraw from Gizu** is separate: it makes a chosen private-USDC amount public
through freshly allocated user-owned receiving wallets, with its own review and
approval. New vault exits do not automatically enter this public cashout flow.

## Accounts and private-balance reads

New Earn cycles use the existing Account 2 private-USDC identity shared with the
wallet. They do not create a separate private Earn account for each investment.
Public funding for a shortfall first credits that private identity before
payouts. Newly prepared returns, including returns from historical investments,
use `returnConfidentialAddress` for Account 2. Already saved legacy operations
retain their original identities, quote bindings and reconciliation policy.

The supported private balance is the exact Monad-origin USDC asset in
[the Earn contract](../../mobile/src/domain/earn/types.ts), not a balance matched
only by symbol. Vault shares, Robinhood USDG and other chains' USDC are distinct
assets and are not new-deposit USDC cash.

Normal Android login establishes one in-memory read grant used by Home, Earn,
payout checks and cashout preparation. Ordinary app switching retains it;
screen/device lock, explicit wallet lock/sign-out, identity/generation change
and process restart revoke it. Foreground refresh uses the existing grant.
Spending approvals, request freshness and short-lived provider authentication
remain separate. See [native storage and authorization](NATIVE_SIGNER_STORAGE.md#android-shared-private-read-session).

Deposit displays reuse the shared portfolio's observed private plus public USDC.
A missing observation does not silently become zero or require a separate manual
balance refresh before review. Fresh balances, reservations and eligibility are
verified natively inside the action. Late results from old wallets/cancelled
requests are ignored; failed reads retain prior observations with unavailable or
incomplete status. Cached display values never authorize spending or settlement.

## Funding, distribution and fees

Native preparation selects eligible private funding first and public USDC for
any remainder. Private sources route directly to saved Robinhood investment
wallets as USDG; public sources first fund confidential USDC. Public source
selection is shared with Swap across eligible public accounts and respects
native encrypted reservations. Prefer one sufficient account; split across
sources when required without silently reducing the requested budget.

Every source must be able to fund its saved allocations after route minima and
fees. `EarnPrivateFunding.kt` currently uses a 0.17-USDC payout quote floor and a
separate 0.01-USDC private-dust threshold. Neither is a universal minimum deposit:
the saved wallet weights, number of sources, public-funding minimum and current
quotes determine feasibility. Warnings identify the routable private amount or
required public amount rather than telling the user only to lower the total.

New distribution cycles use the existing wallet-count/weight algorithm, saved
natively before quotes. Every selected wallet invests. The source budget selects
one wallet below 5 USDC, two for 5–20, two or three above 20–100, three or four
above 100–1,000, and four or five above 1,000. Weights sum to 10,000 bps and remain
within 70–130% of equal weight. Actual investment is lower than gross allocation
after payout fees, vault gas and each wallet's withdrawal reserve. Cumulative
rounding conserves input across multiple funding sources.

A cycle's saved distribution, budget and slot identities are reused after
interruption or restore. Changing an entirely unsigned draft requires explicit
native discard; old identities remain recorded and a new draft allocates a new
cycle. Attached/signed work cannot be discarded to start over. Cycles without
distribution metadata keep their legacy 10/90 hold/invest policy; their holding
wallet must not be swept to complete the investment exit.

The native funding-batch review binds sources, budgets, fee caps, recipients and
wallet generation. It is not unlimited lifecycle approval. The guided deposit
also binds each payout minimum, vault assets/shares and fee/reserve limits.
Changed terms, cancellation or an expired/interrupted grant require the existing
fresh review rules. Signed bytes are persisted before submission; unknown
outcomes remain reserved until reconciliation.

Aurora service-fee qualification lives in
[fee-policy.ts](../../backend/src/adapters/earn/fee-policy.ts). The checked-in
Robinhood policy permits qualified source/withdrawal service charges up to 4 bps
and payout/return service charges up to 45 bps across its allowlisted collectors
and referrals. Gizu integrator fee and application fee are zero. These are caps
on verified quote terms, not fixed charges or claims about collectors' ultimate
beneficiaries. Explicit environment policies can override them; Ethereum needs
its own qualified lifecycle policy. Native review binds the fee proof and stops
on unknown or excessive terms.

## Guided Robinhood deposit (October 11)

Introduced on October 11 and updated by the current distribution/private-funding
implementation. `DepositJourneyScreen` restores unfinished native progress before
showing a new amount. A journal-read failure offers retry rather than pretending
there is no saved deposit. The current journey prepares, reviews, funds, verifies
payout delivery and invests; it stops at the vault position.

Public-funded and existing-private payout members share a native delivery group.
All saved signed payloads and sealed quotes must match its immutable membership,
all routes must succeed, and canonical recipient transfers must cover the saved
minima. Native storage commits the proof and per-wallet allocations together.
A late receipt cannot be attributed twice or assigned to a different deposit.
No invite-only history endpoint is required for this delivery check.

Read-only polling advances canonical origin receipts and private-credit checks
without another app switch. A verified receipt is not blocked merely because a
separate bundler lookup is not yet indexed. Reconciliation still validates exact
signed operation identity, EntryPoint/token events, approved fees and canonical
block hashes. Robinhood execution uses canonical receipts rather than waiting
for its delayed L1-finalized head; Ethereum retains its finalized receipt policy.

## Private return completion and historical correction

The minimum-return verifier binds the saved quote, native-authenticated baseline,
exact origin transaction, destination private identity and durable observation
sequence. It verifies origin execution and route SUCCESS, then requires a fresh
authenticated balance delta at least equal to the approved minimum. The quoted
expected output is not an upper bound for this minimum-credit method. A durable
receipt can replay after the balance is consumed; another incoming credit is
serialized so it cannot be attributed to both routes.

The current minimum-return path does not use Aurora's invite-only account history
for terminal completion or historical correction. Current private balance and provider SUCCESS alone
cannot fabricate an old amount receipt. The separate historical correction
requires an explicit owner report plus native-observed SUCCESS for the exact
saved route, no conflicting later work, public-share observations and a valid
shared private-read session. It commits an atomic, identity-bound terminal
lifecycle record with `spendingAuthorized: false`; it is never spend authority,
a minimum-credit proof or a new payout source.

## October 1 multi-account refresh and approval

This section retains its established link target; the multi-account implementation
was introduced on October 1 and the boundaries below describe current source.
All keys, allocations and the full ownership catalogue remain in encrypted native
storage. The backend receives individual public proposals and opaque coordination
commitments, not the catalogue or signing keys. New cycles use monotonic native
allocation, while historical cycle-zero derivations remain valid. Distribution
slots use their versioned derivation domain. Restore cannot equate missing local
history with absence of a past spend.

Portfolio reads are incremental and bounded; cold/restored catalogues can need
multiple passes. Public and private observations have explicit completeness,
freshness and valuation state. Unknown prices remain unvalued. Allocation,
portfolio scan and encrypted-storage limits are distinct and differ by platform;
none proves exhaustive discovery or available liquidity. Current scan and backup
details are in [portfolio](NATIVE_SIGNER_PORTFOLIO.md) and
[recovery](WALLET_DISCOVERY_RECOVERY.md).

## iOS parity rollout

Supported iOS builds expose Ethereum vault deposits/full redemptions using the
shared Rust policy and Swift encrypted journals. Source sponsorship, private
payouts, Ethereum Fusion liquidity, Robinhood sponsored execution and the Android
partial-withdrawal journey are not enabled by those capabilities. Sufficient
Ethereum USDC/ETH and the applicable explicit review are still required; this is
not an end-to-end iOS Earn funding journey. Shared Rust support alone does not
establish Swift orchestration or device acceptance. See
[native Earn](NATIVE_SIGNER_EARN.md) for capability and transport boundaries.

## Runtime and deployment

The hosted native API is `https://api.gizu.io` on AWS. EAS hosted profiles use the
same JavaScript endpoint. The optional Android debug USB build uses the fixed
native localhost origin described in [native Earn](NATIVE_SIGNER_EARN.md#android-usb-backend-test-build);
JavaScript cannot redirect the native signer. Release uses hosted HTTPS.

Backend changes need a separate release through the existing
[AWS pipeline](../app-guide/AWS_BACKEND_DEPLOYMENT.md); an app rebuild does not
publish them. New native APIs require a rebuilt app, not just Metro. Preserve
PostgreSQL coordination/minimum-receipt data and the stable
`EARN_GATEWAY_RECOVERY_KEY` across deployments so saved proposals and attestations
remain verifiable. The backend owns provider credentials and server-side Anvil
simulation. Never bundle those credentials or a private key into JavaScript.

The backend must expose the matching deposit-preview/private-funding/group-status
and withdrawal-balance/planning routes before the corresponding native client is
used. Unsupported capability/schema or missing simulation fails visibly rather
than widening a proposal. Deployment state must be checked separately; a source
review is not evidence that today's backend or association files are live.

## Implementation and diagnostics

- [Earn domain/profile contract](../../mobile/src/domain/earn/types.ts) and
  [distribution rules](../../mobile/src/domain/earn/distribution.ts).
- [Guided deposit](../../mobile/src/features/earn/DepositJourneyScreen.tsx),
  [withdrawal controller](../../mobile/src/features/earn/useRequestedWithdrawal.ts)
  and [saved position projection](../../mobile/src/features/earn/useVaultPosition.ts).
- [Android deposit preparation](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/earn/EarnDepositPreparer.kt),
  [private routing minima](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/earn/EarnPrivateFunding.kt)
  and [return observations](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/earn/EarnReturnProgress.kt).
- [Backend planning routes](../../backend/src/http/routes/earn-planning.routes.ts),
  [minimum-return verification](../../backend/src/adapters/aurora/minimum-return.ts)
  and [gas management](GAS_MANAGEMENT.md).

Read-only RPC backoff is bounded and excludes signing/submission/fork mutation.
Failed reads never become a zero nonce or balance. Backend planning diagnostics
identify an allowlisted stage/reason without logging credentials, raw payloads
or ownership mappings. Use the [debugging guide](SWAP_DEBUGGING.md) and
[backend runtime](BACKEND_RUNTIME.md) for current log and simulation configuration.

## Verification boundaries

Use package scripts and the release workflow for fresh validation. Unit and
rendered-screen tests mock external boundaries; fork tests prove their pinned
on-chain scenarios, not provider admission or off-chain delivery. No tests,
financial actions, device installs or deployments are newly performed by this
documentation refresh. The November withdrawal regression/device record is
[recorded separately](CONFIDENTIAL_WITHDRAWALS.md#recorded-verification).

The following records remain historical evidence. Their test counts, provider
availability, 10/90 allocations and approval behavior describe those revisions,
not today's configurable distribution, read session or signing policy.

## Historical verification summary

These results were recorded on September 30–October 1, 2026. They are not current
provider availability checks or newly executed tests.

| Milestone                | Evidence                                                                                                                                     | Boundary                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| September 30 integration | Rust 65; Android 140 JVM and USB APK; backend 146 passed/3 optional fork skips; mobile 544 tests/64 suites with full checks and Doctor 21/21 | Existing-wallet login, Home and Earn form observed on Samsung; no complete funded Earn journey.                                                                                         |
| September 30 app funding | Finalized Monad delivery of 3.079262 USDC from 3.081997 input; difference 0.002735 USDC                                                      | Separate, explicitly authorized research-to-app transfer with a one-time 4-bps/referral exception; not Earn acceptance or general fee qualification.                                    |
| October 1 fee correction | Android 143; Rust 67; backend 154 passed/3 optional skips; mobile 548/64 suites and full checks                                              | Phone's 3-USDC unsigned review showed 2.98649 source, 0.00351 sponsorship estimate and 0.01 reserve; route/fee/history blockers kept its sole authorization control disabled. No spend. |
| October 1 multi-account  | Rust 140; Android 220; mobile 604/73 suites; backend 183 passed/3 optional skips; Doctor 21/21, Kotlin format and Swift syntax passed        | Mocked contracts and implementation checks, not live provider or device spending. No device detected at final build check.                                                              |

Details of the separately authorized transfer remain in the
[mainnet test record](../../research/confidential-earn/MAINNET-TEST.md#september-30-app-test-funding).
That record also limits what the successful receipt proves. Existing-wallet login
did not establish new passkey registration or all installed-certificate associations.

## 2026-10-14 — First completed in-app Robinhood deposit

The saved October 13 deposit completed on the phone: funding, verified private
credit, both 10/90 payouts and the vault deposit. Transactions, amounts and blocks
are in the [mainnet test record](../../research/confidential-earn/MAINNET-TEST.md#october-1314-in-app-guided-robinhood-deposit--complete).
Each blocker below was reproduced from phone logs or live provider and chain reads
before it was fixed, and each fix has a regression test that failed first.

- **ByHash reconciliation.** Pimlico returns `eip7702Auth` `chainId`, `nonce` and
  `yParity` as JSON numbers. The gateway rejected them as `-32000`, which the phone
  reported as changed terms. The gateway now converts them to the signer's hex form,
  and native comparison is by value.
- **Private credit.** Aurora's `account/balances?tokenIds=` filter returned nothing for
  a funded account whose unfiltered list held the exact private entry. The balance
  reader now selects `source: "private"` with the exact asset id from the full list,
  as Swap and the research runner do. Public and wrapped `imt:` entries never count.
- **Progress display.** Each polling pass reset the phase to `funding`, so the stages
  alternated. Passes no longer rewind live progress.
- **Resume collisions.** Status polling held the native lock, so "Review remaining
  steps" failed as busy. Confirm and resume now wait for the read-only check.
- **Payout floors.** Previews and signing quotes used 0% slippage, making the floor
  equal to the estimate. Robinhood 10/90 signing quotes now use 5%, and the approved
  floor is the 7% preview minimum. Other payouts keep exact quotes.
- **Payout timing.** Robinhood finality trails by about 17 minutes, longer than one
  15-minute approval. Like Swap, both legs are signed back to back, and Robinhood
  payouts and vault deposits count once their exact receipt is canonical. Ethereum
  payouts, withdrawals and returns still wait for finality.
- **Vault gas bounds.** The fee cap and withdrawal reserve both follow one gas price,
  so exact bounds failed on any movement. Approval allows 25%: the fee cap rises
  25%, the reserve floor is 75%, and minimum assets and shares drop by that headroom.
- **Vault share price.** The Rust core required the planned max share price to match
  a later recomputation byte for byte, but the vault accrues interest every block.
  It now accepts the planned price between the live price and the live price plus
  the approved slippage; every other call byte stays exact.
- **Historical state.** Robinhood's public RPC rejects state reads at blocks older
  than a few minutes. Post-receipt share, delegation-code and nonce checks use the
  latest block there; they change only through a later operation signed by the owner.

Operational notes:

- Rust core changes require `npm run stored-signer:build -- android` before
  `assembleRelease`. The `.so` in `jniLibs` is git-ignored and is otherwise reused.
- Any window-focus loss, including the notification shade, revokes the deposit
  approval (`requireForeground`). Keep the app in front while it runs.
- The backend logs `earn settlement check` and `earn private balance read failed`
  with route status, balance-entry kinds and credit class only. They contain no
  amounts, addresses, tokens or signatures.
- On a 3 USDC budget the 10% hold leg lost about half to a fixed route fee
  (0.2987 USDC in, 0.147037 USDG out).
