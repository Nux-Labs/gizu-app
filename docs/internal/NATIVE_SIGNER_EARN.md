# Native Earn authorization and platform integration

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Reviewed against source on 2026-11-14. This is not a new device, provider or
security verification. See [dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

For the current feature flow, cycle allocation and rollout record, start with
[Confidential Earn](CONFIDENTIAL_EARN.md). The derivation and authorization sections below distinguish current allocation
from the original role design.

## Shared private cash (2026-11-13)

Android uses one in-memory private-balance read session across Home, Earn,
reconciliation and cashout preparation. Login or an explicit private-balance
unlock grants it for the current wallet generation. Ordinary app switching pauses
requests and revokes spending approvals, while retaining read permission. Screen
lock, wallet lock/sign-out and process restart revoke the read grant. Device-lock
observation starts before a grant is opened. There is no read-session timer;
individual empty-intents requests and quotes retain their existing short expiry.
Spending still requires its own operation-bound review and passkey approval.
Feature cleanup uses `cancelWalletOperation` to cancel work and spending authority;
explicit wallet lock/sign-out additionally clear the read session. Older native
builds keep the safe full-lock fallback.

New Earn cycles persist `privateAccount: "shared"` in encrypted cycle metadata and
backups. Their public top-ups are shielded into main-list Account 2 before any
payout, and their private payout signatures use that account. Account 2's existing
private USDC remains the first source for distributed deposits. Public destination
wallet derivation, slot allocation and vault execution are unchanged.

Native intent results expose `returnConfidentialAddress` as Account 2. New return
plans use it even when exiting an older investment. Saved legacy return proposals,
signatures and settlement reads keep the original recipient. A cycle without the
shared marker retains its historical funding identity, and historical private
balances remain discoverable and spendable. Recovery refuses conflicting private
identity markers instead of silently changing an existing cycle.

When an unsigned deposit has a public remainder below its route minimum, native
preparation returns the exact selected private amount, uncovered amount and
minimum public budget in the public snapshot's `message`. The UI displays that
explanation for `uneconomicAmount`, including a private-only budget when one was
selected. A zero selected private amount explains the per-source minimum instead
of recommending a smaller deposit. Legacy public-funded drafts state their saved
public funding minimum separately. All amounts use six-decimal integer arithmetic;
the final review still determines fees and vault credit.

Incoming shared-account credits are sequenced across sponsored and Ethereum
journals. Unfinished shared-account deposit payouts and signed private payouts
reserve their cash; an unfinished Swap must be reconciled before another incoming
balance snapshot. Confirmed Ethereum nonce cancellations release their reservation.
Normal public-funded Swap buys spend at most their own guaranteed route credit;
pre-existing Earn proceeds and execution surplus remain private in Account 2.

Shared cycles do not add unused legacy private accounts to balance discovery.
Platform reads and Rust signing still validate the actual owned private identity,
including an explicit historical candidate when recovering older addresses.

These changes require rebuilding the native signer and app. They do not move old
private balances automatically or alter already signed operations. iOS preserves
the metadata/read contract within its existing execution capabilities.

## Confidential Earn v1 boundary

New distribution deposits use the versioned plan described in
[Confidential Earn](CONFIDENTIAL_EARN.md). Distribution slots are derived at
`m/44'/60'/145'/{chainId}'/{cycleIndex * 8 + slot}` for slots 0–4. Their payout legs
are `invest:0` through `invest:4`; vault, delegation, liquidity and withdrawal
proposals bind `investmentSlot` to the persisted native cycle. Missing distribution
metadata retains the v1/v2 legacy role derivations below. Neither backend quotes
nor JavaScript can choose an arbitrary signing account or change saved weights.

The main application source is legacy account 0, viewed as Monad mainnet Circle USDC.
The existing MON transfer policy remains chain 10143 only. The new Earn entry point
is [documented separately](CONFIDENTIAL_EARN.md). Android supports the guarded Earn execution paths. iOS supports Ethereum vault execution; other Earn execution capabilities remain disabled.

After explicit intent and native review/passkey approval, `prepareEarnIntent` binds one
supported destination profile and persists it atomically. Destination roles are derived
at `m/44'/60'/143'/destinationChain'/role`: role 0 holds; role 1 invests. Chains 1 and 4663
use distinct branches, separate from legacy accounts. Retries/readback recover the same pair.
The same 32-byte entropy derives these branches. Later cycles use
`m/44'/60'/144'/{chainId}'/{cycleIndex * 3 + role}` and persist their allocation
metadata. Distribution slots use the separate 145 branch above. Version-3 backups
include saved cycle metadata; Android recovery sync/discovery can recover newer
allocations. Never reuse an index from an older backup without reconciliation.

Role 2 is an internal confidential identity, not a third public destination wallet.
On Android, `readEarnBalance` reuses the shared private-read grant described above;
when locked, explicit native authorization is required. The native read fetches
the fixed public Intents salt and asks Rust to construct/sign an empty ERC-191
read-authentication payload. iOS retains its separate native read authorization
flow and does not implement Android's shared private-read session. The core accepts no arbitrary message or spending intents. Signed authentication
is sent directly from native code to the fixed Gizu backend; signatures, entropy and provider
session credentials never cross Expo. The public result is an authenticated aggregate
Monad-USDC balance with `operationScoped: false`, never settlement authority.

Restore exposes candidate addresses but keeps `earnRecoveryRequired` set. Changing candidates
while gated is read-only; neither a balance check nor zero local history clears this flag.
Wallet ID, journal generation and profile are rechecked across authorization/network calls.
Full funding and return completion require separately authenticated operation-scoped evidence.

## Requested exits, receipts and refunds

Android advertises `earnPartialWithdrawals`. Robinhood withdrawal proposals bind
an optional requested USDG amount/request ID to exact selected shares, cycle and
investment slot. Native checks current shares and `previewRedeem`, allowing one
base unit of downward rounding and at most the greater of one base unit or 10 bps
upward drift. A private return binds the canonical redemption and its gross
proceeds; it cannot spend unrelated reserves. Shares remaining in the vault keep a
next-withdrawal reserve of 2.6 times the approved redemption fee cap. A later
portion requires a new request/approval. iOS does not advertise this capability.

Saved minimum-return receipts bind immutable wallet/generation/proposal/origin
facts and remain terminal after the credited private cash is spent. A completed
portion leaves the remaining investment intact. Provider SUCCESS and aggregate
balance alone do not create a credit receipt or spending authority. The separate
owner-confirmed historical correction records lifecycle completion with
`spendingAuthorized: false`; it cannot fund another payout.

A bound REFUNDED observation means public USDG returned to its source, rather than
private USDC received. A retry prepares a fresh private return from the original
redemption proceeds, obtains new approval and never redeems the same portion again.
Encrypted recovery validates terminal observations under their source generation
before rebinding; failed reads and nonterminal observations are not terminal proof.
Read-only progress polling does not plan, sign or resume financial work. See
[requested withdrawal and refund rules](CONFIDENTIAL_WITHDRAWALS.md#requested-robinhood-vault-withdrawals)
for the full ladder, fee preflight and acceptance record.

### iOS Ethereum vault execution

The existing `executeEarnVault`, `listEarnVaultOperations`, `resumeEarnVaultOperation` and `cancelEarnVaultOperation` methods now use Swift native orchestration and the shared Rust transaction policy. Review/passkey authorization lasts two minutes and is invalidated by cancellation, lock, expiry and backgrounding. Entropy and signed bytes stay native. The per-wallet-generation encrypted journal commits before broadcast, checks revisions and prevents concurrent operations for one owner. Refresh reconciles without sending; resume requires explicit fresh approval. Unsupported funding, payouts and liquidity flags remain false. See the [rollout and remaining gates](CONFIDENTIAL_EARN.md#ios-parity-rollout).

### Android USB backend test build

Native Earn normally uses `https://api.gizu.io/v1/earn/native` on the hosted HTTPS backend. An explicit Gradle
`-PgizuEarnBackend=usb` opt-in selects only
`http://127.0.0.1:3000/v1/earn/native` in **debug** builds. The aggregate private-balance
read uses the same backend with the pinned `/v1/earn/private-balance` path. Debug builds
without the property keep hosted HTTPS; release builds always keep hosted HTTPS even if the
USB property is passed. Other property values fail the build. There is no URL parameter,
Expo setter or change to chain RPCs, native policy, review or passkey authorization.

For a connected Android device, run the ignored local backend configuration on port
3000, reverse both backend and Metro ports, and use the same loopback base for JavaScript:

```sh
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
# From mobile/android, with the configured JDK 17 and Android SDK:
./gradlew :gizu-stored-signer:testDebugUnitTest :app:assembleDebug -PgizuEarnBackend=usb
# From mobile (in a separate terminal):
EXPO_PUBLIC_API_URL=http://127.0.0.1:3000 npm run start -- --localhost
```

Install the resulting debug APK using the normal local device workflow. Rebuild without
`-PgizuEarnBackend=usb` to return native requests to hosted HTTPS, and set JavaScript's
`EXPO_PUBLIC_API_URL` to the same hosted HTTPS base. Backend provider credentials stay
in the ignored backend environment file; never put them in Expo public configuration.
The USB option is a local transport choice and does not make preview or signing automatic.
