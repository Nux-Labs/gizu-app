# Confidential Earn integration

The supplied `research/confidential-earn/APP-INTEGRATION-HANDOVER.md` is the product specification. This file records the app integration and its verification boundaries; it is not permission to send a mainnet transaction.

## User actions

New vault exits finish in confidential USDC. Making those funds public uses the
separate **Withdraw from Gizu** flow, with its own native approval and fresh
distributed receiving wallets. Saved legacy public payouts retain their original
policy. See [confidential withdrawals](CONFIDENTIAL_WITHDRAWALS.md) for current
sale/exit completion, recovery and deployment behavior; dated entries below
preserve earlier implementation stages.

**Earn ends at an invested vault position.** The initial fee calculation simulates a future full redemption in a disposable server-side fork only to estimate the withdrawal reserve. It never withdraws the live position. The user must click Withdraw later, review fresh fees, and authorize redemption separately. Aurora return quotes and operations follow that requested exit; their future executable costs are excluded from the initial deposit estimate.

When selecting withdrawal activity, a native `redeemed` inventory row is not proof
of an unfinished private return. Selection reuses the existing exit verifier:
authenticated saved operation credit (including minimum-return evidence), fresh
zero shares and residual valuation, and no unresolved legacy public payout. A
completed old exit is skipped before the next investment is shown. Reopening the
screen re-reads the native journals. A previously verified full exit is retained
as wallet/profile/intent/slot-scoped presentation history, matched against every
native operation and legacy payout revision/status. It does not need new prices
or the current private balance, which may already have been spent or redeposited.
Unrecorded or changed activity still requires fresh public state and the existing
completion checks. Pending and recovery activity cannot use recorded history.

These non-secret observations never authorize spending or remove assets from
portfolio reads. **Check past withdrawals** explicitly discards the observation
before checking current balances/prices, keeping later external funds or residuals
in an old investment wallet reachable. Failed checks show status unavailability;
the position overview never invokes this flow. No provider history API is used.

The position screen is an overview. Opening it or selecting **View investment**
after a guided deposit does not select an old Earn cycle or mount withdrawal
recovery. **Withdraw** opens the separate protected withdrawal route; an explicit
Withdraw action in vault details goes directly there. That route retains older
unfinished return activity and its recovery checks. Back returns to the screen
that requested withdrawal. An old **Return to private balance** step must never
be presented as the next step required to complete a new deposit.

New guided Android deposits display the same **observed private USDC + public
USDC** owned by the shared wallet portfolio, with a breakdown of both. Private
USDC means the Monad-origin USDC asset in the native confidential catalogue;
vault shares, USDG, other tokens and other chains' USDC are not deposit cash.
Opening a deposit or returning to the app does not start a separate balance
verification or require a refresh. A missing display observation still permits
native review of a valid amount. Explicit refresh and wallet actions update the
shared observations; failed reads retain the prior display. Prices may expire
without triggering balance RPCs. Reads triggered by an action wait for earlier
reads/authentication and reject late results from before that action or a
previous wallet. An action finishing after navigation still refreshes its wallet;
an action finishing in the background defers that update until foreground.

Native preparation and signing continue to authenticate fresh balances and
reservations inside the requested action. Insufficient funds use a distinct
outcome across public funding, private payouts, sponsored operations and
confidential withdrawals; failed reads and unavailable previews remain distinct.
Authenticated action reads update the shared encrypted private observations,
and verified payout delivery attempts to record the remaining source balance.
No frontend observation can authorize spending or establish settlement.

Robinhood deposit and exit planners and payout receipt reads use the shared
read-only EVM transport. It retries transient RPC/HTTP failures up to three times
with viem's backoff, within a 12-second deadline for the whole read including
`Retry-After`. Caller cancellation remains effective. Its method allowlist excludes
signing, submission and fork mutations. Fresh nonce reads and all nonce-change,
identity, canonical-block and quote-expiry checks remain required; no failed read
becomes a zero nonce or a cached balance. Financial submission transports do not
use this retry policy.

The two globally admitted disposable forks are each configured for 150 CU/s
instead of 1,000. Their combined configured budget is 300 CU/s, leaving room for
live chain reads under the observed 500 CU/s Alchemy account limit. This is a
per-process limit, so replicas and other applications must share an operator
capacity allowance. At Nov12 01:36:44, Alchemy's Gizu request log identified the
failed EntryPoint08 `getNonce(address,uint192)` read as HTTP/JSON-RPC429, preceded
by throttled fork storage reads. This was RPC throughput exhaustion, not a
missing private funding/history record.

Funded Robinhood plan failures also attach a `planning` object to the existing
backend `private.error` log. It identifies the failed state read, market quote,
vault simulation, deposit/withdrawal sponsorship, final sponsorship, freshness or
plan validation stage. Only fixed internal reason/SDK error labels, numeric upstream
HTTP/JSON-RPC codes, `AA` plus two-digit validation codes and allowlisted backend
module/line locations are retained. Positive Alchemy429 is preserved as
`rpc-throttled`; it is not discarded as a nonstandard positive RPC code.
Upstream messages, raw stacks/paths, owners,
amounts and requests are excluded. Responses keep the existing generic error contract. This diagnostic
does not retry, relax funding checks or grant signing/execution authority. A live
`EARN_ROBINHOOD_PLAN_UNAVAILABLE` requires this backend build to be deployed before
the failing stage can be established from CloudWatch.

Exit snapshot failures attach an `exitSnapshot` object to that same request-scoped
`private.error` event. Filter CloudWatch for route `/v1/earn/exit-snapshot` and
correlate using `reqId`. `stage` distinguishes chain reads, reference validation,
price fetching, price validation, canonical checks, valuation and final freshness.
`reason` retains a fixed internal validation label; HTTP/JSON-RPC status, allowlisted
TLS/network codes and SDK error types survive without retaining the raw exception.
Price validation includes `asset` (`token`, `usdc`, or `native`) and, when its
timestamp is parseable, `priceAgeMs` and `priceMaxAgeMs`. Negative age identifies a
future timestamp. Price-fetch failures retain HTTP status even if response JSON
parsing fails; transport failures have no HTTP response status.

For example, a stale-price failure would log the following diagnostic object
(illustrative, not a captured production event):

```json
{"stage":"prices-validate","reason":"price-expired","asset":"token","priceAgeMs":300001,"priceMaxAgeMs":300000}
```

The logger excludes owners, balances, prices, URLs, headers, provider bodies,
messages and raw stacks. Public error responses and all freshness/security checks
are unchanged. This instrumentation requires a backend deployment; no app rebuild
or AWS configuration change is needed.

Native preparation rechecks eligible private accounts and selects them first.
Their USDC goes directly through an advanced-confidentiality, exact-input route
to the saved Robinhood investment wallets as USDG, without a public Monad
cashout first. Public USDC covers any remaining budget through the existing
funding path. Private account dust below 0.01 USDC remains untouched and is
excluded from available deposit cash; this prevents zero allocations under any
valid basis-point distribution. Every selected source is checked again before
signing, and the native grant binds its identity, input, saved allocation,
recipient and minimum output. Saved deposits retain their original funding
policy. Private-only deposits do not create public funding transactions or need
a public funding gas reserve.

Public funding uses Circle USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (six decimals) on Monad mainnet 143. Swap and Earn share native public source selection across accounts 0, 1 and allocated public receiving accounts, with fresh balances and shared reservations. A sufficient single account is preferred; a larger budget can span multiple sources. One combined native review and passkey assertion authorizes the selected source funding operations. Each source retains its own fees, transaction and recovery journal. Changed terms or an interrupted/expired approval require a fresh review of the remaining sources.

Private funding uses `/v1/earn/native/private-funding/prepare` and `/status` with
the existing authenticated read and signed intent boundaries. The server fixes
the destination to Robinhood USDG; the Rust signer derives the source and saved
investment recipient independently. Encrypted native journals retain exact
signed bytes before submission. Lost responses preserve reservations and permit
an explicit exact-byte retry; the saved signed route and canonical destination
transfers are required before vault funding is attributed. No history endpoint
is required. A marker-only interrupted local signing attempt can be resumed under a fresh
grant because submission is unreachable until signed bytes are durably saved.

Distribution delivery is verified per investment wallet across all public-funded
and existing-private payout members. The verifier reuses signed-route status and
canonical receipt checks from Earn, with grouped transfer accounting from
withdrawals. It does not assign a public transfer to a particular private source.
Every sealed quote and saved signed payload must match the review membership;
all member routes must succeed, and canonical transfers must cover the saved
minima. Native verification preserves paid sibling amounts and durably commits
the shared receipt proof and remaining allocations together. Later deposits
cannot alter completed delivery. Exact signed membership and receipt-event
commitments prevent replay across groups without storing an address catalogue.

Opening a Robinhood deposit first reads the local encrypted journal for unfinished
progress. It restores that deposit and budget before offering new funding; a
failed lookup offers a retry instead of an empty amount form. This does not read
balances or request signing permission. Sufficient independently confirmed
delivery receipts can complete a group before its historical scan reaches the
current head; the accepted event set stays fixed across retries and later gifts.

Vault fee previews remain hypothetical and cannot authorize spending. They use
only the requested budget even when USDG has already arrived before its local
receipt verification completes. Additional live tokens never increase that
budget, and claimed starting funds must still exist. The funded execution path
separately requires verified attribution. A failed remaining fee preview retains
its preview failure reason and allows the existing remaining review to retry.

Private funding uses the same qualified `payoutRobinhood` service fee policy as
the preview. The backend seals the actual fee proof into recovery; native review
binds it to the quote and enforces the reviewed fee cap and minimum output.
Gizu/integrator fees remain zero. Provider outages pause with their own reason
instead of claiming that live terms changed. A private source observation before
the first payout child does not permit lifecycle cleanup to erase the review.
Older rows with a missing review and no attached children recover to an unsigned
draft; rows with child history require reconciliation and retain that history.
Other private spending is blocked while the deposit owns its sources. The
backend retains only opaque coordination commitments, without an address
catalogue. Deploy these backend routes before using the new Android build with
private funds; backend deployment remains an explicit release.

New Android deposits use the existing Swap wallet-count and weight algorithm, saved natively before destination quotes. Every selected wallet invests in the chosen vault. The source budget selects one wallet below 5 USDC, two for 5–20, two or three above 20–100, three or four above 100–1,000, and four or five above 1,000. Weights total 10,000 basis points and stay within 70–130% of an equal share. These shares allocate verified confidential credit; independent payout fees, vault gas and each wallet's retained withdrawal reserve reduce the invested amounts. Multiple funding sources use cumulative rounding so the allocated input is conserved.

The native cycle saves `distribution: {version: 1, weightsBps}` and the original budget. Retry and restore reuse the same plan and derived wallets. Changing an entirely unsigned draft requires an explicit native discard; its identities remain recorded and a new draft allocates a new cycle. Attached or signed child work cannot be discarded this way. Funding credits are independently verified before payouts. Robinhood's single native review binds every wallet's minimum assets, maximum gas and withdrawal reserve; each wallet then has an independent payout and vault transaction. Ethereum retains its separate stage approvals and selects each saved investment slot. Saved progress retains completed siblings when another wallet pauses.

Cycles without distribution metadata retain the legacy hold/invest policy: wallet 1 receives floor(total confirmed private input / 10), wallet 2 receives the remainder, and only wallet 2 invests. Their keys, signed operations, withdrawal ownership and recovery behavior are unchanged. The legacy holding balance must not be swept to finish an investment exit. Distribution wallets have no intentional holding allocation; each retains its own withdrawal reserve and is selected separately for withdrawal.

Distribution investment slots use the new `145'` derivation domain; the cycle's existing confidential identity is unchanged. Wallet backup metadata preserves slot count, weights and budget. Restored local progress still requires reconciliation before spending. Updated native capability `earnDepositDistribution` is required for new preparation; older builds retain access to their legacy saved deposits. Full iOS deposit execution remains unavailable. Deploy the matching backend and rebuild the native app before trying the new flow; these changes do not update an installed app or the AWS service automatically.

## Implementation map

- `src/services/wallet/usdcBalance.ts`: pinned chain/token balance reads, exact base-unit strings, timeouts and malformed-response rejection.
- `src/services/wallet/earnWallets.ts` and native stored signer: immutable profile/pair preparation after user intent, backup-compatible derivation, restore reconciliation gate.
- `src/domain/earn/policy.ts` and `lifecycle.ts`: integer fee/reserve formulas, split conservation, cost ledger, uncertain-operation and exit policies.
- `src/services/earn/`: real read-only readiness, authenticated private balance, independent native quotes and final exit snapshots. An aggregate private balance alone is not operation-scoped settlement evidence; new native journals bind a pre-spend snapshot, exact route and bounded delta.
- Backend `adapters/earn/`: dynamic isolated fork simulation and unsigned destination deposit planning. Backend `adapters/pimlico/source-funding.ts`: address-only source sponsorship preparation, conservative ceiling fee cap, bounded approval and fresh-state validation. No preview signs or broadcasts.
- Native `core/src/earn_execution.rs`: constrained Ethereum allowance/deposit/full-redemption transactions. The core derives only the investment role, constructs canonical pinned Morpho SDK router calldata, binds native review and revision, and requires fresh native state before signing.
- Native Rust `earn_sponsored.rs`, `earn_ethereum_liquidity.rs`, and `earn_payout.rs`: source/Robinhood token sponsorship; exact native USDC permit/Fusion order; constrained USDC/native ETH returns; exact independent confidential payouts. No generic digest, calldata, key or signature authority is available to JavaScript.
- Android native engines/journals: passkey-bound review; encrypted signed-before-submit records; exact saved-byte recovery; canonical receipt/finality checks; authenticated operation-specific credit. Pending Ethereum liquidity transactions support separately reviewed same-nonce cancellations and retain every candidate until the finalized winner is known.
- `features/earn/`: guided Robinhood deposit, staged Ethereum deposit, saved investment/recovery and separately approved exits. All default execution adapters are real native/provider adapters; functional tests inject services only at those boundaries.

The initial destination namespaces are `m/44'/60'/143'/destinationChain'/role`, with role 0 holding and role 1 investing. The separate confidential identity is role 2. Cycle zero keeps that historical derivation. New cycles use a monotonically allocated native cycle index. Each requested exit allocates a new public receiving address, saved before execution and reused on retries; it never returns to the original funding account. The encrypted catalogue and backup retain cycle/receiver relationships. Restore never clears the spending gate merely because local history is missing.

## iOS parity rollout

The first stage implements **Ethereum vault deposits and full redemptions** through the existing Earn screens and public contract. `earnVaultExecution` is available on supported iOS builds; source sponsorship, private payouts, Ethereum Fusion liquidity and Robinhood execution remain unavailable. This is not yet an end-to-end iOS Earn journey. The investment wallet must already have sufficient Ethereum USDC and ETH; the app does not bypass unavailable funding capabilities.

- `ios/Earn/EarnVaultEngine.swift` delegates exact proposals, review hashes and signing to the same Rust `earn_execution.rs` policy used by Android. The approved amount, owner, contracts, nonce, fees and deadline remain bound.
- `EarnVaultRPC.swift` reads chain 1 at a canonical block hash, rejects stale or reorganized snapshots and keeps all amount arithmetic in shared Rust U256 helpers.
- `EarnVaultJournal.swift` encrypts wallet-generation records and commits signed bytes before broadcast. A failed submission remains locked and recoverable. Status reads never broadcast; explicit resume requires a fresh native review/passkey assertion and retries saved bytes exactly.
- `EarnVaultReconciler.swift` validates transaction fields, finalized canonical receipts, expected allowance/deposit/redemption events, shares and actual gas costs. A reorganization restores the pending lock. Approval and investment/redemption are separate authorizations; there is no automatic second transaction. After approval finalizes, both platforms give the unsigned router continuation a fresh five-minute deadline and native review. The operation identity, amount and finalized approval stay bound; gas limits and fee caps remain unchanged and are revalidated against fresh state. Signed router retries use their saved signing deadline and never refresh or alter signed bytes.
- Cancellation stops new signing but retains unresolved transactions. Restore keeps the existing recovery gate and starts a separate journal generation; it cannot infer that a missing journal means no past spend.

Remaining stages: source sponsorship and shared source reservations; private credit/payouts and cycle recovery; Ethereum liquidity/return/cancellation; Robinhood execution and Earn portfolio extensions. Before enabling another writer for the same Ethereum investment account, integrate its pending journal into a shared nonce lock. Independent per-engine locks are insufficient.

Verification for this stage: 51 Swift simulator tests, 148 Rust tests with strict Clippy, Android Debug/Release unit tests, 629 JavaScript tests across 76 suites with coverage, TypeScript, lint, formatting and iOS registration checks passed. The arm64 simulator app compiled successfully. Native tests exercise real Rust signing with injected RPC/storage failures; JavaScript tests mock the native boundary. Physical-iPhone passkeys and funded Ethereum execution remain untested. No mainnet transactions were sent.

## Runtime and deployment

The hosted native API is `https://api.gizu.io` on AWS ECS; JavaScript uses `EXPO_PUBLIC_API_URL`. JavaScript updates load through Metro in the development app; native API changes require rebuilding and installing the APK. Local backend changes do not alter the deployed service. Use the existing [AWS deployment pipeline](../app-guide/AWS_BACKEND_DEPLOYMENT.md) to release the matching backend from `main`.

The history-free distribution build also requires `/v1/earn/native/payout/group-status`
on that backend. Keep the existing gateway recovery key and coordination database
when releasing it so saved signed quotes remain verifiable. After release, resume
the existing deposit with **Review remaining steps**; do not create a replacement
deposit for an already submitted payout. Delivery verification uses the saved
signed payloads without signing or submitting them again.

For the requested pre-deployment phone test, `-PgizuEarnBackend=usb` builds Android debug with a fixed native `http://127.0.0.1:3000` backend. Set Metro's `EXPO_PUBLIC_API_URL` to the same origin and reverse ports 3000 and 8081 over USB. This is compile-time local testing; JavaScript cannot select a native endpoint. Omitting the property keeps the hosted backend; release always uses the hosted HTTPS backend. See [native USB setup](NATIVE_SIGNER_EARN.md#android-usb-backend-test-build).

The local server uses an ignored, permission-restricted `backend/.env` with provider credentials copied by name from the authorized research configuration and an isolated local PostgreSQL database. No research wallet keys or signing journals are imported. A new local-only durable recovery key is retained in that file; production must retain its own stable key. The qualified Aurora fee configuration and installed-certificate association remain required even when the backend runs locally. Publishing the frontend association can enable device signing without deploying the backend.

The production container, pinned Linux Anvil runtime and release steps are documented in [AWS backend deployment](../app-guide/AWS_BACKEND_DEPLOYMENT.md). Keep provider keys on the server: the existing `ONEINCH_API_KEY`, plus `AURORA_API_KEY` and `PIMLICO_API_KEY` for their respective paths. `ETHEREUM_RPC_URL` can select a qualified HTTPS RPC. `EARN_ANVIL_PATH` must point to a working server-side Anvil binary with pinned-fork access; missing simulation blocks that proposal. No Anvil process or provider key belongs in the mobile app.

The frontend service builds from `frontend` with `npm ci && npm run build`, publishing `dist`. The prepared `.well-known/assetlinks.json` adds this APK certificate and preserves the previous certificate. Verify its publication on `gizu.io`, particularly before new credential registration. Existing-wallet passkey access succeeded on the connected Android phone during the local test; this does not establish new registration or transaction authorization. Dashboard configuration and deployment credentials still need verification at deployment time.

## Provider qualification and remaining gates

Aurora's normal service fees are permitted by the handover; Gizu adds no application fee. The inspected portal configures zero integrator fee and no collection address/custom rules. The checked-in Robinhood policy bounds the actual observed collectors and two referrals; it does not assert the collectors' ultimate beneficiaries. Unknown identities or higher fees stop new spending. See [Aurora API keys and fees](https://docs.intents.aurora.dev/getting-started/api-keys-and-fees.md).

The Android paths now include source funding and authenticated private credit, two independent payouts, Fusion permit/order execution, both destination vaults, and separately requested withdrawal/returns. Execution fails closed when provider qualification, simulation, gas, current native state or passkey association is missing. Publish the backend and verify the Android association before trying the deployed journey; a local implementation is not a live deployment.

`EARN_AURORA_FEE_QUALIFICATION_JSON` optionally overrides the checked-in Robinhood lifecycle policy. Ethereum routes still require their own explicit qualified policy; legacy exact-2-bps/no-referral configurations remain supported. Retain the durable 32-byte hex `EARN_GATEWAY_RECOVERY_KEY`: its AES-GCM envelopes authenticate prepared quotes, balance snapshots and portable credit attestations across restarts. They remain inside encrypted native storage. Keep the same key when restarting/deploying; no recovery key is shipped in the APK. Ordinary native balance-delta settlement does not require Aurora's history invitation. Better execution above the quoted estimate needs exact authenticated history, as described in [confidential withdrawal verification](CONFIDENTIAL_WITHDRAWALS.md); previously signed journals without snapshots retain their original reconciliation requirement.

Unsigned payout reviews may refresh authenticated evidence and, only after native proof that no signature exists, replace an expired quote within the same funding-role reservation. Signed or uncertain submissions retain their exact payload and nonce. Cancelling an unsigned payout review retains its original role reservation; explicitly refreshing that saved child enables a new native review, without allocating the role again. An expired sponsorship preparation may be explicitly discarded before any spending UserOperation is signed. Saved delegation authorization remains encrypted; discard does not revoke that authorization or broadcast it. Closing a screen locks authorization and discards late UI results; it does not cancel an external transaction.

Exit completion requires wallet 2's zero shares, explicit WETH reconciliation, authenticated credit for each expected return leg and fresh spendable residual strictly below 0.5 USDC equivalent (below 0.1 optimal). Public provider success, an aggregate private balance or a receipt alone is insufficient. Unknown submissions and reorganizations must be reconciled before a new operation can be authorized.

## Verification record

Use the npm scripts in `mobile/package.json` and `backend/package.json`; full checks must be rerun after integration changes. Isolated Ethereum and Robinhood fork checks have demonstrated exact SDK deposit/full-redemption calls and separately simulated returns. Reserve estimation uses disposable child forks and leaves the parent fork invested. This does not establish live resolver admission, paymaster sponsorship, Android passkey/device acceptance or iOS acceptance. Those earlier fork checks did not include an iOS build; the iOS parity rollout above records subsequent simulator verification.

No mainnet Earn operation has been sent during this integration. The user separately authorized the research-to-app funding transfer recorded below.

## Recovery and platform limits

Reopen Confidential earn and use the saved-progress controls before authorizing another operation. A saved source or return receipt first requires native authenticated private credit; payout delivery also requires an independently verified destination transfer (canonical for Robinhood payouts, finalized for Ethereum payouts and withdrawals). Provider status alone never unlocks an uncertain spend. An expired signed Ethereum raw transaction may still confirm: use the explicit pending-cancellation review when the journal offers it and existing ETH covers the replacement gas fee. Both candidate transactions remain tracked.

Each investment has an immutable destination pair/profile. Previous cycles remain selectable for withdrawal and recovery, and a new investment allocates a fresh cycle. Restore without native history remains gated; missing journal data is not evidence that an old operation never spent. Automatic sibling-wallet top-ups, generic replacement transactions and WETH unwrap signing remain unsupported.

Android execution has native and screen-level test coverage. iOS enables only the Ethereum vault execution capability described above. The remaining execution capabilities stay unavailable; simulator checks do not establish device acceptance. Mainnet resolver admission, live paymaster acceptance, passkey ceremonies and the complete deployed phone journey require separately reported provider/device checks. No vault funds moved during implementation; the separately authorized app test funding is recorded below.

## Durable review and recovery decisions

- Independent payout quotes replaced joint hosted previews; do not send both
  destination addresses together merely to render a preview.
- Exit checks require refreshed native return evidence plus a canonical investment
  snapshot. Price token, ETH and WETH conservatively; a server residual flag alone
  cannot prove completion.
- Narrow only fresh unsigned payout deadlines to the validated quote expiry before
  hashing/review. Signed and recovered payloads remain immutable.
- React Native's installed abort implementation lacked `throwIfAborted`; adapters
  use a shared `aborted` check before requests and after asynchronous results.
  Regression tests reproduced the failure before the fix.
- Unsigned blocked previews use the existing funding panel, show real estimates
  only when available and disable authorization. They carry no signing binding.
- Executable quote recovery and native approval bind the versioned fee policy and
  exact fee breakdown. Preserve legacy signed authority and retry bytes.
- `EARN_AURORA_HISTORY_QUALIFIED` defaults false; qualification requires authenticated
  operation-specific evidence. Public SUCCESS and aggregate balance are insufficient.
- Read-only previews bind their maximum 60-second lifetime to the verified quote
  timestamp and separately enforce local freshness/expiry. This does not extend
  native spending deadlines.

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

## Historical provider diagnosis

On October 1, 09:02–09:06 UTC, thirteen unsigned quote probes (saved research
requests, different amounts, dry/firm, slippage, deadlines, confidentiality and a
public control) returned Aurora HTTP 500 with upstream `1Click returned HTTP 521`.
Direct 1Click token/quote requests independently returned 521. This established an
upstream availability failure for those checks, not the infrastructure cause or
global outage scope.

Aurora incidents returned 13 entries including the HOT bridge; its relation to the
earlier `Quoting for this pair is not available` response remained unconfirmed.
Authentication returned 500, so earlier invite-only history denial remained the
latest entitlement evidence. Fee qualification was independently unresolved.
Sanitized responses and request settings remain in the
[provider diagnosis fixture](../../research/confidential-earn/fixtures/aurora-provider-diagnosis-2026-10-01.json).
No spending signature or transaction was sent during that investigation.

For a new test, recheck route availability, fee beneficiaries/referrals and
operation-scoped history entitlement. Do not infer today's service status from
this incident or weaken settlement rules to work around it.

## October 1 multi-account refresh and approval

Historical design snapshot; current UI refresh triggers may differ. The bounded
read policy and approval constraints below record the implementation decision.

All keys and the complete account/cycle graph stay in native device storage. The backend receives individual public operation proposals, never the ownership catalogue or signing keys. Existing components display the merged portfolio and per-source progress.

Ordinary app openings refresh encrypted snapshots with bounded work: token synchronization uses at most 80 balance reads and eight transfer-log calls per token shard, with HTTP batches of at most 40 calls. Public Monad USDC has one shared cursor. Other token/vault groups rotate (at most six groups per opening), and native gas observations rotate (at most eight accounts). Confidential Monad USDC rotates at most four identities within the wallet-opening read session; historical identities continue on later openings. Incomplete coverage stays explicit. Metadata and vault conversions are reused per asset. Unknown prices remain unvalued rather than being treated as zero or one dollar. Cache observations never authorize spending or prove operation settlement. Robinhood’s public RPC cannot read its older finalized contract state, so its display observers use current canonical samples with separately retained log checkpoints. Those rows identify their latest-block observation finality. Robinhood payouts and vault deposits verify canonical receipts and read post-receipt state at the latest block (October 14); other execution and settlement checks keep finality.

The native batch approval binds the wallet, journal generation, registry, selected owners, budgets, recipients, original requests and fee caps. It is memory-only and expires after the existing 15-minute signing-session window. Native signing still verifies exact final UserOperation/paymaster terms within those limits. Separate downstream payout, investment and withdrawal actions retain their own approvals. This batches source funding approval; it does not approve an unlimited or automatic full lifecycle.

The scalability bounds currently cover up to 8,192 public accounts and 256 Earn cycles per device. A cold/restored catalogue is synchronized incrementally. Funding review probes fresh candidate balances separately with a bounded search; an incomplete portfolio is not a promise that every account has been searched. Confidential valuation currently covers the configured Monad USDC asset only. Full iOS execution and live provider/device acceptance remain separate verification gates.

## Guided Robinhood deposit (October 11)

The catalog Deposit action opens Amount → Review → native approval → progress →
Invested. Review allocates exactly two fresh destinations and a cycle confidential
identity in encrypted native storage, with no signing, transfer or extra passkey.
Editing or retrying an unsigned draft reuses that pair. Source selection uses the
existing multi-account planner and shared Swap/Earn reservations. The amount is a
USDC budget including source gas and the retained 0.01-USDC margin.

On Android, `earnDepositJourney` exposes five native methods: prepare, confirm,
status, resume and cancel. A normal uninterrupted Robinhood deposit receives one
final native semantic review/passkey. Its memory-only grant binds owner, journal
generation, cycle, source membership/reservations, both destinations, fixed
contracts, source budgets, minimum payout/deposit/share amounts and gas/reserve
bounds. The grant lasts at most 15 minutes while foregrounded; quote deadlines
remain shorter. All exact children still pass the existing Rust/native checks.
It grants no withdrawal or return authority. EIP-7702 delegation and provider
identity disclosures remain in the final native review.

Funding children keep their own durable journals. All selected sources must have
authenticated operation-specific credit before the cumulative 10/90 payouts start.
Each source has independent hold/invest payouts. Only verified investment payout
receipts establish wallet 2's permitted deposit budget; unrelated incoming tokens
do not enlarge it. Success requires canonical deposit evidence and minted shares.

Leaving the screen, backgrounding, locking, closing or Stop remaining approval
revokes further signing, preserving all submitted children. Explicit Resume
refreshes only unsigned remaining terms before a fresh native approval. Paid
payouts and durably signed bytes remain unchanged. Missing child history fails
closed. The prospective refresh may include verified USDG already delivered to
wallet 2, and requires the real balance to equal that starting amount. A signed
vault child uses its saved bounds and reconciliation rather than replacement.

Saved investment details retain existing withdrawal/return and funding recovery
controls, without a new source-funding amount. Exits still allocate fresh receiving
addresses. Ethereum keeps its existing separately approved funding, payouts,
liquidity and vault stages; this branch does not claim one-passkey Ethereum.
iOS advertises `earnDepositJourney: false` and preserves existing vault APIs.

### Teammate deployment checklist

Deploy this branch's backend before testing the new APK's review. In addition to
the existing executable routes it must serve these **read-only** POST endpoints:

- `/v1/earn/native/payout/preview`: per-source Robinhood USDG route estimate;
  dry quote only, with qualified provider fee proof and a short expiry.
- `/v1/earn/robinhood/deposit-preview`: isolated prospective simulation for the
  pinned USDG/Steakhouse contracts; expected USDG and optional verified starting
  USDG, without executable calldata or UserOperation fields.

Keep the existing provider keys, qualified `EARN_AURORA_FEE_QUALIFICATION_JSON`,
`EARN_AURORA_HISTORY_QUALIFIED`, stable `EARN_GATEWAY_RECOVERY_KEY` and RPC
configuration. `EARN_ANVIL_PATH` must identify the pinned runnable Anvil on Render;
this preview additionally needs fork/debug access to prove the USDG balance slot.
Wrong/reverting storage candidates are restored and rejected, never guessed.
The hypothetical override and fork-only ETH donor cannot authorize live execution.
Missing qualification or simulation support produces an unavailable review.
Do not rotate recovery keys during deployment or print them in compatibility logs.

Run backend typecheck/test/build, deploy through the existing teammate workflow,
then probe both public endpoints with an invalid empty body: the deployed strict
routes should return 400 rather than 404. Follow with valid unsigned previews
before requesting a funded phone approval. JavaScript and native release endpoints
both use `https://gizu-app.onrender.com`; an old backend's 404 blocks before funding.

### Current verification boundary

Deterministic checks pass for source/credit ordering, odd-atom splits, bound grants,
crash journals, uncertain submissions, paid-child preservation, unsigned remaining
refresh, stale amount results, screen exit and saved investment ownership. The
JavaScript suite passed 728 tests across 90 suites with coverage. Backend
checks passed 225 tests with three optional skips, typecheck and build. Rust passed
148 tests. All 273 Android signer tests and Kotlin formatting passed.

The aggregate mobile check stops at Expo Doctor: network-enabled Doctor passed
20/21 checks, with installed Expo 57.0.26 versus expected ~57.0.27. Types, lint,
formatting and coverage were run separately; the aggregate is not reported as
passing. Native iOS checks are unavailable on this checkout because Pods support
files and a simulator runtime are absent. No iPhone acceptance is claimed.

The hosted new deposit-preview route returned 404 during the October 11 probe.
A separate live Robinhood RPC/fork probe returned HTTP 403 before simulation; the
new prospective fork path is therefore not live-qualified by this test. These
are deployment/provider gates, not permission to use fallback executable terms.
No new mainnet Earn spending or funded one-passkey phone acceptance has occurred.

### Final review and phone check

A fresh whole-branch review found five Important recovery/lifecycle gaps; the fix
pass reproduced and addressed them: exact-byte payout retry on explicit Resume
only; authenticated receipt reconciliation before remaining preview; screen-off
and Home/Recents revocation during credential UI; unsigned-review reservation
release; and journaled reservation ownership before sticky source binding.
Public polling never rebroadcasts. Missing child records and signing uncertainty
continue to block reservation release. Any registered child set is conservatively
retained for existing explicit recovery/discard actions.

Pre-review reconciliation uses only the existing native owner/generation-bound
login read permission (two minutes). It signs empty-intents authentication, never
asset-transfer authority. An expired permission requires unlocking the wallet
again; the feature does not renew it silently or ask for a spending approval to
obtain unknown remaining economics. Historical signed children remain immutable.

Review preparation may open that native read-only credential prompt. JavaScript
leaves its lifecycle handling to the native operation, as it does during confirmation;
native Home/Recents, screen-lock and foreground checks still revoke real departures.
An unsigned, failed preparation has no spending authority to cancel on screen cleanup,
so its preview failure is retained rather than replaced with an approval-stopped state.
Retry displays preparation progress instead of the previous cancellation message.

Android lifecycle wiring uses screen-off and system Home/Recents events, plus
interactive/keyguard checks on activity pause and the user-leave callback. Legitimate
credential focus loss remains bounded; an intervening departure cancels the pending
ceremony permanently. The receiver observes system broadcasts listed in the
[Android platform reference](https://developer.android.com/about/versions/12/reference/broadcast-intents-31);
it does not send the deprecated close-dialog action. Physical credential-focus and
lock acceptance still requires the deployed review/provider path.

The initial guided standalone release built and updated the Samsung phone using `adb install -r`.
Its package and SHA-256 certificate matched the existing installation; wallet data
was preserved. The embedded bundle contains the new Render host and guided native
bridge, and no old backend host. The user unlocked the wallet. The phone deposit
hierarchy showed Morpho/Steakhouse USDG, an entered 3-USDC budget, available USDC,
Review deposit and Details, and the correct unavailable-preview alert with no
Confirm action. Both required public preview routes returned 404. No spending was
approved. Prospective review, one-passkey funded execution and live interruption
recovery remain incomplete until backend deployment and usable providers.

The final recovery-fix release rebuilt successfully with all 273 Android signer
tests passing. Its certificate and Render bundle endpoint were verified again.
USB disconnected before that last update, so the phone currently retains the
initial guided build. The final APK is ready for a preserving `adb install -r`.
A coverage rerun hit ten test timeouts during an abnormally long 62-minute run;
all were timing failures in previously passing suites. The fresh run with idle sleep
prevented passed all 728 tests in 151 seconds. No timeout was increased or test
skipped.

### October 12 deployment diagnosis

Both hosted preview routes now validate empty requests with HTTP 400, confirming
the new handlers are deployed. Valid diagnostic previews return HTTP 503. The
hosted source quote specifically returns `EARN_AURORA_FEE_UNQUALIFIED`; the operator
reported none of the four `EARN_*` runtime/qualification settings are configured.
See the [deployment guide](../app-guide/BACKEND_DEPLOYMENT.md) for their purposes.
Local live Aurora dry source and USDG quotes returned HTTP 200, but no accepted
local fee registry was configured. Public Robinhood state and Pimlico market reads
passed; the prospective fork timed out reading vault `previewDeposit`. That local
simulation result does not establish the deployed fork's failure reason.

Android preparation diagnostics use the `GizuEarnDeposit` log tag. They record only
the preparation stage, allowlisted gateway/transport failure code and Kotlin code
location; never exception messages, request bodies, addresses, amounts, credentials
or signatures. Preparation still blocks spending, releases unsigned reservations
and preserves the existing public pause contract. Capture with:

```sh
adb logcat -v time GizuEarnDeposit:W GizuRpc:W '*:S'
```

Both diagnostics regressions and the complete 275-test Android suite pass. The
standalone release built successfully; its existing certificate and embedded
`https://gizu-app.onrender.com` host were verified. It updated the connected Samsung
with `adb install -r`, preserving wallet data. After the user unlocked and reviewed
3 USDC, the log identified `sources / VALIDATION / EarnSourceReplanner.kt:264`:
the funding-plan nonce did not match the native EntryPoint lane-zero nonce.

The installed SDK's default nonce manager selects a time-based lane when the
backend omits an explicit nonce. Native state, signing and reconciliation use lane
zero. Monad funding preparation now explicitly reads `account.getNonce({key: 0n})`,
matching the existing Robinhood paymaster adapter. It does not hardcode a zero
sequence or change native nonce validation or historical signed operations. The
full SDK integration fixture now models EntryPoint lane bits and verifies repeated
unsigned preparations retain a nonzero lane-zero sequence. It failed before the
patch and passes afterward; the backend suite passes 226 tests with three optional
skips, plus typecheck and build. A read-only live comparison against the previously
supplied funded Monad source confirmed the deployed plan selected a nonzero lane
and failed the native nonce comparison, while the patched local planner queried
the same mainnet providers and returned lane zero with the correct live sequence.
Neither comparison signs or broadcasts. Deploy this backend correction as well as configuring
the missing Earn settings. No live spending was authorized or sent during these
probes.

### October 12 Aurora fee portal inspection

Read-only inspection of the signed-in Client Portal matched its key to the backend
and research key without publishing that key. The public integrator fee is zero,
there are no custom fee rules, and no fee collection address is configured.
Confidential fees inherit the public configuration. No portal setting was changed.

Fresh diagnostic dry quotes returned HTTP 200 for all four Robinhood lifecycle
routes. Source and public Monad withdrawal list 4 bps to
`widget_collect.sputnik-dao.near`. Robinhood payout and return list 25 bps to that
collector plus 20 bps to
`2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805`.
All four include referral `aurora-jh500bnyo9`. These are listed quote fees, not a
complete accounting of route costs. The portal's zero integrator fee does not
identify those collectors' beneficiaries or the referral's commission terms.
Those remain unqualified pending Aurora confirmation; no fee-policy registry was
installed. See the [sanitized fee inspection](../../research/confidential-earn/fixtures/aurora-fee-inspection-2026-10-12.json).

The same live responses omit `quote.deadline`, as Aurora's documented dry-response
contract permits. Source and payout preview adapters now use only a short local
indicative lifetime when executable expiry fields are absent. Any supplied expiry
is still checked, and executable quote validation is unchanged. Both missing-expiry
regressions failed before this correction and pass afterward. The backend suite
passes 228 tests with three optional skips; typecheck and build pass. No signing or
submission occurred.

### October 12 confirmed runtime blockers and resolution

See the [sanitized runtime diagnosis](../../research/confidential-earn/fixtures/aurora-runtime-blockers-2026-10-12.json).
The deployed source preview now succeeds but reports fee and history qualification
blockers. These two codes are our configured eligibility checks, not proof of a
quote-service outage. The history flag is false, and no accepted full-profile fee
policy has been established.

A fresh empty diagnostic account authenticated successfully (HTTP 200, access token
issued, signed payload contained zero intents). Its authenticated `account/history`
request returned HTTP 400: `History is invite-only for now`. This independently
confirms provider access is missing on the inspected local/portal key. No user
wallet keys or transfer intents were used. Aurora must grant that entitlement;
setting the flag true cannot create it. After access is granted, validate actual
operation-specific source/payout evidence before qualifying settlement.

The pinned vault's direct mainnet `previewDeposit` succeeded in 373 ms. A read-only
relay recorded a fork dependency returning HTTP 403 with a Cloudflare HTML challenge
on `eth_getStorageAt`. This explains the local fork failure and provides a reproduced
cause consistent with the deployed timeout; Render's exact failing upstream request
is not available. Later hash-string, pinned-number and EIP-1898 reads succeeded, so
no deterministic block-selector defect is established. Use a dedicated mainnet RPC
with reliable pinned storage access through existing `ROBINHOOD_RPC_URL`, then
repeat the full prospective simulation. The official Alchemy demo endpoint rejects
unlisted origins and is not a production substitute. No dedicated provider key is
currently configured locally, and a replacement full simulation remains unverified.

The fee policy requires Aurora confirmation of the observed collectors and referral
beneficiaries. Render currently reports referral `aurora-1u3j2qzclc`, while the local
inspected key reports `aurora-jh500bnyo9`; the operator reports the keys are the same.
That discrepancy remains unexplained. Final rules must match the deployed key's
verified settings rather than assuming the local referral applies everywhere.

The following can be sent by the operator to Aurora; no message was sent by this task:

> For our Gizu Confidential Earn key (portal key ending 059a), please enable authenticated
> `GET /api/account/history/{apiKey}`. Authentication succeeds but history returns
> HTTP 400, "History is invite-only for now". Also confirm the beneficiaries of
> `widget_collect.sputnik-dao.near` (4 bps source/withdrawal, 25 bps Robinhood payout/return)
> and `2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805`
> (20 bps Robinhood payout/return), and whether either referral pays Gizu or an
> integrator commission. Our portal shows zero integrator fee, no custom rules and
> no collection address. The same reported key returns `aurora-jh500bnyo9` locally
> and `aurora-1u3j2qzclc` from Render; please explain and confirm the intended fee
> configuration for all four lifecycle routes.

## 2026-10-13 — Native Earn without history invitation

New native funding/return signatures save an authenticated balance baseline before submission. Each funding source waits for successful route status and a credit delta bounded by its saved quote; only then can the next source sign. Portable sealed credit attestations allow both 10/90 payouts and recovery after private funds are spent. Payout reconciliation verifies the exact saved signed intent, successful route, and canonical token-transfer receipts (finalized outside Robinhood); the same receipt cannot fund two allocations to the same recipient. Investment still stops at the vault deposit; withdrawal remains a separate user action with fresh recipient addresses.

The inspected zero-Gizu portal configuration and observed fee/referral allowlist are checked into the backend. `EARN_AURORA_FEE_QUALIFICATION_JSON` is now an optional override, and current native clients do not require `EARN_AURORA_HISTORY_QUALIFIED=true`. Legacy signed journals without baselines retain their original reconciliation requirements. Deploy the backend and install the matching APK; preserve the recovery key and configure the owned Robinhood RPC. No transactions were sent to qualify this implementation.

### Source review: supported paymaster signature lengths

The deployed funding plan returned HTTP 200, but phone diagnostics identified
`sources / VALIDATION / EarnSourceReplanner.kt:278`. Its direct-token paymaster
payload was 183 bytes; both the Android replanner and Rust Earn signer accepted
only 182. Pimlico's [official decoder](https://github.com/pimlicolabs/singleton-paymaster/blob/master/src/base/BaseSingletonPaymaster.sol)
supports a 118-byte configuration followed by a 64-byte compact or 65-byte full
signature. Both Earn parsers now accept exactly 182 or 183 bytes, preserve the
complete signature, and retain the existing mode, flags, token, expiry and fee
checks. Unsupported lengths still fail closed. Research already accepted both
sizes; no provider setting or fee-policy change is needed for this correction.

Regression tests failed before the parser changes and pass afterward. The full
Android suite passes 280 tests and the Rust suite passes 149 tests. The standalone
Render-targeted APK built and was installed with `adb install -r`, preserving
wallet data. These checks do not establish successful mainnet execution; no
spending signature or transaction was sent.

### Vault preview request timing

After the operator deployed the owned Alchemy Robinhood RPC, two read-only Render
previews returned HTTP 200 in 17.6 and 46.7 seconds. The phone's remaining failure
was `vault-preview / TIMEOUT`, with the default native 20-second read timeout.
The exact hosted or USB vault-preview endpoint now uses a 60-second read timeout
and 70-second overall call timeout; ordinary RPC calls retain 20/30 seconds.
Redirect and automatic connection retry remain disabled. Quote expiry and native
review freshness validation are unchanged: a late response cannot authorize stale
terms. A preview taking more than 60 seconds can still time out. Final review
timestamps start when preparation completes and retain the earliest real provider
expiry; aging payout and vault terms are freshly requested. No success claim for the
full deposit lifecycle follows from these unsigned preview checks.

The planner repeats complete deposit/redemption simulations while converging on
the deposit amount and conservative fee/reserve budgets. A stable offline fixture
requires two simulations and five paymaster preparations. Live profiling with the
owned RPC observed 20 stub requests and 15 bundler gas estimates for those five
preparations. Their provider round trips, repeated simulation work and additional
convergence passes explain why this is slower than a vault view call.

Deposit and redemption sponsorship preparations now overlap: both are unsigned,
use their own exact calls/storage overrides, and share the pinned state and fee
ceiling. The final deposit preparation, state/fee checks and reserve calculations
remain required. A local parallel sample completed in 20.5 seconds (two simulations,
five preparations); a subsequent sequential sample took 33.8 seconds (three
simulations, seven preparations). Different convergence counts prevent treating
these samples as a guaranteed speedup. The backend suite passes 240 tests with
three optional fork tests skipped; SDK integration coverage verifies parallel
requests retain separate calldata, overrides and lane-zero nonce without signing
or submitting. Deploy the backend scheduling change separately from installing
the APK's extended preview read limit. Do not extend quote/review validity merely
to accept a one-minute provider response.

### Swap-style Earn preparation

Earn keeps the existing coordinator, source planner and signing engines. The
existing deposit page now shows verified, non-authorizing indicative held and
investment amounts while exact vault fees and reserves are prepared. Only a
complete fresh native review enables confirmation and its single bounded passkey
approval. No new page or coordinator is introduced; withdrawals remain a separate
user action.

Hold/invest payout reads overlap. The backend retains the maximum observed
deposit and withdrawal fee caps during convergence, preserving the 105% deposit
fee ceiling and 260% withdrawal reserve. Final fee preparation must fit those
bounds. This avoids chasing alternating smaller quotes without inventing fees or
reducing reserves. Aging payout minima trigger new quotes and a vault calculation
using their updated amounts, with a maximum of three vault attempts.

New native deposit reviews permit later unsigned funding children to refresh
their nonce, deadline, quote ID and bridge deposit address within the exact
reviewed source identity, amount, fee ceiling and minimum confidential credit.
This authority lives only in the current native grant; old reviews and standalone
funding batches retain strict canonical matching. Quote validation, native calldata
validation and authenticated settlement remain required, and durable signed bytes
cannot be replaced. No Swap tolerance is silently added to the reviewed limits.

Preparation publishes only public progress fields through the existing native
status method. That status read can run during preparation; signing mutations
remain serialized. Session changes, backgrounding and navigation discard late
progress and cancel the matching unsigned draft, including before its first poll.

An unsigned live diagnostic against the owned RPC completed in 44.2 seconds with
two simulations and five paymaster preparations. Its first fork simulation took
24.3 seconds and its second 1.5 seconds. This later sample confirms provider
variability; it does not establish a guaranteed improvement over the earlier
20.5/33.8-second samples. Submission methods were blocked and no mainnet spending
signature or transaction was sent. Deploy the backend optimization and install the
updated native APK separately before the funded device test.

Final optimization verification: 242 backend tests passed with three optional
fork tests skipped; 287 native Android tests and the complete 736-test mobile
suite passed. Type checks, mobile lint and the standalone release build passed.
Independent review found an unsigned-cancellation retry dead end; navigation and
expired-draft regressions reproduced it before the fix. Those drafts can now
prepare again using the same pair, while deposits with saved funded progress
retain remaining-step recovery. The Render-targeted APK was installed with
`adb install -r` and opened on the connected phone. Backend deployment and the
user-authorized funded execution test remain separate steps.

### Live settlement progress and Swap presentation

The current Swap on `main` keeps expected Aurora/receipt waits inside its native
execution loop and publishes progress. Earn's native host already had the same
bounded polling behavior, but its coordinator incorrectly reported every missing
credit or receipt as a paused recovery state while that approval was still active.
This exposed a redundant remaining-review action during normal waiting.

An active Earn grant now reports `funding` until the origin receipt is finalized,
`settlingCredit` until authenticated private credit is verified, `payouts` until
the destination receipts are verified, and `depositing` until vault settlement.
The existing host polls and continues within the original 15-minute approval.
Reconciliation without a spending grant still pauses for explicit recovery; actual
failure, cancellation, backgrounding and expiry do not regain spending authority.
No signed packet is replaced or automatically reapproved.

The existing Earn page adopts Swap's presentation: status badges, an active-step
spinner, highlighted stage rows, a count/bar of verified steps, a budget summary,
and an open-screen note. Saved recovery limits are available under Details; fresh
review limits remain visible before approval. No new component or coordinator is
introduced. A native host regression demonstrates delayed credit and payout
receipt continuation with exactly one approval; rendered coverage confirms no
remaining-review action during an active wait.

Swap's current core also contains a route-success/quoted-minimum fallback if its
authenticated balance endpoint returns 401. Earn retains its operation-scoped
authenticated settlement evidence rather than copying that different financial
policy. This change corrects live progress reporting, not provider settlement speed.

### Final sponsorship failure found on October 13

The phone's native execution log identified `pm_getPaymasterData` returning the
Earn gateway's generic `-32000` error. This happens before the source UserOperation
is signed/submitted; reporting it as a confidential-credit wait was incorrect.
Read-only reconciliation now preserves the real stop reason, and sponsorship RPC
rejections display a separate gas-sponsorship message. Native diagnostics retain
only the RPC method, numeric code, allowlisted classification and source location.
They do not log request bodies, provider messages, wallet addresses or signatures.

An authorized live **unsigned** Pimlico probe reproduced `AA23` with the empty
UserOperation signature. Changing only that field to the installed Simple7702
SDK's 65-byte simulation signature succeeded. The successful final response had
only `paymaster` and `paymasterData`; the gateway previously required both gas-limit
fields too. Swap's SDK already uses that simulation signature and merges final
sponsorship fields into the estimated operation.

The Earn gateway now validates the phone's unsigned packet first, uses the SDK
simulation signature only in the outgoing `pm_getPaymasterData` request, and
retains estimated paymaster gas limits when the final provider response omits them.
The merged final operation is validated again. The placeholder is never returned
as signing authority or accepted for submission; signed operations and native
EIP-7702 authorizations retain their existing validation. The 10/90 split, fee caps,
withdrawal reserves, source reservations and device-held keys are unchanged.

Deploy this backend patch to Render before retrying the **same saved deposit**.
No new environment variable or wallet pair is needed. The live probe did not sign
or submit a transaction; successful sponsorship is not proof of final investment.

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

### November 9: minimum return confirmation without history

New Android vault returns negotiate `minimum-return-v1`. This is an explicit
provider-backed lower-bound confirmation, not an exact output record or an
independently verifiable private-chain proof. It requires the original sealed
quote and pre-funding balance snapshot, fresh account-owner read authentication,
success for that saved route, a matching canonical source-chain funding receipt,
and a private USDC increase covering the quoted guaranteed minimum. Robinhood
source verification uses canonical execution receipts without waiting for delayed
L1 finality; Ethereum preserves finalized execution checks.

The response is `minimumReceived`, with `verifiedMinimumAtoms`, immutable
`observedAtMs`, and a distinct `minimum-return` sealed envelope. It explicitly
sets `exactAmountKnown: false` and `spendingAuthorized: false`. There is no
`creditedAtoms` or `source-credit` envelope. Native journals retain this evidence
separately from exact settlement; source-funding and existing exact-credit payout
validators reject it. UI says “At least … USDC verified.” Exit completion still
refreshes native operation evidence and the investment wallet's shares/residuals.

The durable PostgreSQL exclusion ledger retains a permanent per-private-account
observation sequence and an immutable record per route. Account/route identities
and financial binding commitments use domain-separated server-keyed HMACs; no raw
wallet addresses, signatures, snapshots or user-to-wallet catalogue are stored.
Records retain only these keyed commitments, the sequence, verified minimum and
observation time. The tables are created by the adapter and have no TTL. Balance
snapshots carry the sequence read before and after their authenticated balance
observation. Committing a confirmation checks and advances that sequence atomically.
Two phones/replicas cannot commit distinct returns against the same observation
window. Rechecking an existing route reconstructs its original receipt without
recounting or requiring its funds to remain unspent.

An older unfenced snapshot is eligible only before that private account's first
minimum confirmation. Overlapping older observations are rejected rather than
reconstructed from a later aggregate balance. The existing signed operation must
be reconciled; never re-fund it to resolve this error. Keep the exclusion tables
and the stable recovery/HMAC key across deploys and database recovery. Resetting
this ledger, restoring it to an older state, or rotating its key without a migration
invalidates the anti-reuse guarantee and is not a supported maintenance procedure.
Wallet backup restoration preserves the original financial bindings and migrates
native journal generation bindings only through the validated history importer.

The full private balance remains an independent authenticated portfolio observation.
Minimum receipts never add to that balance or cap it. Surplus and historical cycle
accounts remain discoverable and available for fresh balance-based spending.

“Withdraw from Gizu” separately negotiates `destination-receipt-group-v1`.
It retains fresh private-balance checks and the user's native signing approval.
A deterministic whole-plan identity binds the original private sources, exact
amounts, distribution weights and the same 1–5 native-derived receiving wallets.
Several source transfers may share a receiving wallet. All source ownership proofs,
sealed quotes, exact signed private debits and successful routes must match before
a group can complete. Partial signed progress reports the existing routes without
requiring a funded child to be submitted again.

The exact public delivery is verified per receiving slot by summing unique
canonical finalized Monad USDC transfer events, rather than attributing each public
transfer to one private source. Each slot must cover the sum of its quoted minima.
The receiver is permanently bound to the whole plan, and a sealed zero-balance
anchor permits later unsigned quotes to reuse that same receiver after earlier
children funded it. No additional receiving wallets or consolidation transactions
are introduced. Each canonical event is permanently bound to the immutable group,
with only keyed commitments retained server-side. Native checks the canonical
events independently and commits the group atomically, preserving already-paid
child amounts and allocating the remaining actual delivery deterministically.
Pending slots retain positive matching events rather than an estimated upper
bound. A fully paid slot revalidates only its original canonical event set and
fixed paid amount; later ordinary incoming funds remain separate and cannot block
other pending slots. This proves public group delivery, not exact private-ledger provenance.

Owner proofs are generated locally from one freshly read salt per bounded batch,
and checked before provider reads. Read-only verification uses bounded concurrency
and separate transport limits; financial approval/deadline checks are unchanged.
The encrypted cashout journal is included in backup history. Trusted import checks
the original generation, deterministic plan, signed children, nonce history and
paid allocations before rebinding the destination journal generation. Group evidence
and pending signed work remain recoverable on another phone.

New cashout receipt claims are independent of the provider intent hash, so an
older wallet backup can reconcile them with the saved signed payload. A legacy
history-based event claim can be reused only when its exact original intent hash
is available and the complete legacy ownership commitment matches. Missing legacy
hashes and attempts by old clients to consume new-version claims fail closed;
existing claims are never cleared or reassigned to make recovery succeed.

Old exact settlement/history methods remain available for compatible saved flows.
The November 11 deposit update replaces the private-funded-deposit history
dependency with saved signed-route and canonical destination verification,
including grouped delivery for guided distributions as described above. No
financial transaction is submitted by minimum-return verification or receipt
reconciliation.
