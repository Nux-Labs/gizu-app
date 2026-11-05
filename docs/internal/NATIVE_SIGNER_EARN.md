# Native Earn authorization and platform integration

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Extracted from the signer reference on 2026-10-08. This split preserves the
recorded implementation details; it is not a new device, provider or security
verification. See [dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

For the current feature flow, cycle allocation and rollout record, start with
[Confidential Earn](CONFIDENTIAL_EARN.md). The v1 boundary below records the initial
derivation and authorization design; it does not supersede later cycle allocation.

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
The original verified 32-byte entropy backup covers these branches. Additional independent
cycles require a versioned allocator and recovery discovery before reuse is allowed.

Role 2 is an internal confidential identity, not a third public destination wallet.
`readEarnBalance` performs native review/passkey authorization, fetches the fixed public
Intents salt, and asks the Rust core to construct and sign an empty ERC-191 read-authentication
payload. The core accepts no arbitrary message or spending intents. Signed authentication
is sent directly from native code to the fixed Gizu backend; signatures, entropy and provider
session credentials never cross Expo. The public result is an authenticated aggregate
Monad-USDC balance with `operationScoped: false`, never settlement authority.

Restore exposes candidate addresses but keeps `earnRecoveryRequired` set. Changing candidates
while gated is read-only; neither a balance check nor zero local history clears this flag.
Wallet ID, journal generation and profile are rechecked across authorization/network calls.
Full funding and return completion require separately authenticated operation-scoped evidence.

### iOS Ethereum vault execution

The existing `executeEarnVault`, `listEarnVaultOperations`, `resumeEarnVaultOperation` and `cancelEarnVaultOperation` methods now use Swift native orchestration and the shared Rust transaction policy. Review/passkey authorization lasts two minutes and is invalidated by cancellation, lock, expiry and backgrounding. Entropy and signed bytes stay native. The per-wallet-generation encrypted journal commits before broadcast, checks revisions and prevents concurrent operations for one owner. Refresh reconciles without sending; resume requires explicit fresh approval. Unsupported funding, payouts and liquidity flags remain false. See the [rollout and remaining gates](CONFIDENTIAL_EARN.md#ios-parity-rollout).

### Android USB backend test build

Native Earn normally uses the fixed HTTPS Render backend. An explicit Gradle
`-PgizuEarnBackend=usb` opt-in selects only
`http://127.0.0.1:3000/v1/earn/native` in **debug** builds. The aggregate private-balance
read uses the same backend with the pinned `/v1/earn/private-balance` path. Debug builds
without the property keep Render; release builds always keep Render HTTPS even if the
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
`-PgizuEarnBackend=usb` to return native requests to Render, and set JavaScript's
`EXPO_PUBLIC_API_URL` to the same hosted HTTPS base. Backend provider credentials stay
in the ignored backend environment file; never put them in Expo public configuration.
The USB option is a local transport choice and does not make preview or signing automatic.
