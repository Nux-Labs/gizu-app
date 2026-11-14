# Stored-wallet native signer

The active local Expo module is `GizuStoredSigner`, under native package
`io.gizu.storedwallet`. The retained `gizu-signer` module is inactive and excluded
from app linking. This module supports Android 9+ development and release builds and iOS 18+ development and release builds; physical iOS acceptance remains pending.

## Implemented boundary

- Native `createWallet` requires a native confirmation and Credential Manager
  registration. Registration is verified against challenge, origin, RP and P-256
  credential metadata. PRF-enabled registration is required for later recovery.
- Random 32-byte entropy is generated only after the provider returns to a focused,
  unlocked app. Rust derives all 16 public accounts to check core availability.
- `WalletStore` encrypts a bounded binary record using AES-256-GCM, application-bound
  AAD and an Android Keystore key. Entropy is not encoded into JSON or strings.
  Checked file sync, atomic rename, directory sync and read-back commit writes in
  `noBackupFilesDir`. Legacy AtomicFile backups remain readable. Missing key/corruption produces
  `recoveryRequired`; existing data is never overwritten by creation.
- The Keystore key does not require user authentication: passkey authorization is
  enforced by native code, not secure hardware. Native memory compromise is outside
  this boundary. Managed/provider/FFI copies cannot be promised forensic erasure.
- `openWallet` verifies a fresh signed assertion, bound to the wallet and open
  purpose. Decrypted entropy is cleared before waiting for credential UI. Opening
  does not establish reusable spending authority or backend authentication.
- A process-wide mutex serializes ceremonies. Lock, teardown, cancellation and the
  two-minute timeout invalidate work. Only bounded credential-provider and document-picker waits can
  survive an activity pause; foreground and unlocked state are required on return.
- Native responses are explicit public maps. Errors are fixed messages without
  underlying provider, key, file or crypto details. A cancellation after an atomic
  write may leave a valid backup-required wallet; query state rather than recreate.

## Verified backup and app access

`backupWallet` saves an encrypted file through Android's document picker, then
requires reopening it and a fresh passkey PRF check. It compares wallet identity,
entropy and all 16 accounts before marking `ready`. Cancellation keeps the same
backup-required wallet; ready wallets remain ready when a later backup is cancelled.
`restoreWallet` requires the file and original passkey and only accepts absent or
unreadable local storage. It never overwrites a healthy wallet. No file paths or
contents cross Expo. See [backup format and lifecycle](../../../docs/internal/NATIVE_SIGNER_STORAGE.md).

Native capabilities report eligibility in Android development and release builds
(API 28+ with an Activity). The Gradle library's minSdk 24 is a compilation floor. The app gates entry on `ready`; Account offers backup management.
Withdraw and Activity use native exact-transfer review, passkey authorization and
an encrypted operation journal. Signed bytes are saved before broadcast; refresh
only reconciles. Explicit resume requires fresh authorization and retries saved
transactions byte-for-byte. Unsigned cancellations are compacted; when the active
journal fills, settled records are encrypted and durably archived before removal.
Unresolved signed records remain active. Activity shows the active window, not local
archive files. Entropy-file restore starts a new journal generation. Android additionally exposes
separate encrypted recovery sync, history import and read-only discovery; these
require their native capabilities and the backend recovery service. See
[recovery protocol](../../../docs/internal/WALLET_DISCOVERY_RECOVERY.md). The explicit
`npm run debug:stored-wallet` harness remains available, with no legacy fallback.
Guided phase-4 phone checks were user-reported successful; extended failure-path
acceptance remains pending.

## Earn and confidential portfolio capability limits

Android advertises guarded distributed Earn deposits, Account-2 private funding,
partial Robinhood withdrawals, private payout/liquidity execution and confidential
public cashout. The shared in-memory private-read session survives ordinary app
switching; lock, sign-out, screen lock and process restart revoke it. Spending
requires its own operation-bound approval. New Earn cycles persist
`privateAccount: "shared"`; saved legacy identities and signed returns keep their
original account. Minimum-return receipts and bound refund observations remain
terminal lifecycle evidence after cash is spent, without becoming arbitrary
spending authority. See [native Earn](../../../docs/internal/NATIVE_SIGNER_EARN.md).

iOS advertises stored wallets, backup, transfers, swaps, Earn wallets and Ethereum
vault execution. Sponsored funding, private payouts, Ethereum liquidity and guided
Earn deposits remain false; recovery/discovery and partial-withdrawal flags are
absent. Android's private-read grant and owned-asset/Earn extensions do not imply
iOS parity. Query `getCapabilities` rather than inferring support from methods.

## Ownership and verification

- `core/`: adapted derivation and exact-transfer policy from the retained Rust core,
  now consuming random wallet entropy. No fixed-message probe exports. Native-only
  UniFFI bindings are not a JavaScript signing API.
- `android/`: Expo lifecycle, native prompts, credential verification and storage.
  `rpc/` owns bounded Monad transport; `transfers/` owns operation persistence,
  reconciliation, exact-transfer orchestration and native review.
- `scripts/build.sh`: generates native bindings and Android libraries by default; `ios` builds device/simulator XCFramework slices on macOS.
- Generated bindings, targets and binaries are ignored; never edit them manually.

From `mobile/`:

```sh
npm run stored-signer:test
npm run stored-signer:build
cd android
./gradlew :gizu-stored-signer:testDebugUnitTest :app:assembleDebug
```

The build needs Rust 1.94.1, the aarch64-linux-android target, Android NDK
27.1.12297006 and a macOS/Linux host. The JVM tests exercise storage failures,
AES-GCM integrity and passkey verification using synthetic data; they do not prove
Android Keystore behavior or physical-device/provider support.

The prototype supplied the starting credential verifier/envelope and their tests.
The crypto core retains the original pinned Rust dependencies. Android adds CBOR
4.5.6 for parsing authenticator registration data and uses existing OkHttp 4.9.2
for Monad RPC; no wallet secrets go through JS.

## iOS stored signer

The iOS 18+ implementation uses the same public contract and Rust policy, with
Swift/AuthenticationServices, CryptoKit, Keychain and native document pickers.
Run `npm run stored-signer:build:ios` before iOS prebuild or pod installation.
`npm run stored-signer:test:ios` runs native tests on an available iPhone simulator;
set `GIZU_IOS_TEST_DEVICE` to choose a simulator UDID. `npm run stored-signer:check:ios`
checks generated Expo registration and the Pods graph for legacy-signer exclusion.

Local records use a binary entropy suffix and encrypted public metadata. Files use
complete protection, atomic checked writes and exclusion from automatic backups.
The non-synchronizing Keychain encryption key uses
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. Removing the device passcode can
make the key unavailable; recovery requires the encrypted backup and original
PRF-capable passkey. The key is not a Secure Enclave secp256k1 signer, and spending
approval remains enforced by native application code.

Both native backup codecs write v3 and read v1–3. V3 encrypts entropy, role
registry and saved Earn metadata; v1/v2 remain legacy reader formats. The
TypeScript identity constant still declares backup version 2. Android accepts
files up to 16 MiB while iOS is bounded to 64 KiB, so format compatibility does
not establish equal capacity or provider interoperability. Swift/JVM fixtures
under `ios/Tests/Fixtures` contain synthetic public entropy/PRF/credentials.
Cross-platform provider/recovery acceptance is deferred.
Restoration verifies the recovered address, discards plaintext before confirmation,
then obtains fresh PRF authorization for committing local storage.

`Package.swift` builds a native-only test target; it never supplies fake credentials
or keys to the app. Generated Swift bindings and XCFrameworks are ignored. The
retired signer remains untouched and excluded. Native simulator tests and an app
build do not establish physical iPhone, passkey-provider, Keychain or file-picker
acceptance. Real-device validation and independent security review remain pending.

### iOS source map

- `ios/GizuStoredSignerModule.swift`: Expo public contract, ceremony serialization and timeout.
- `ios/Access/`: ceremony lifetime, passkey provider and verification. `WalletCeremony`
  owns cancellation and presentation; its backup and transfer extensions keep each
  workflow together without introducing a second owner of authorization.
- `ios/Storage/`: device-bound Keychain key, protected atomic files, encrypted wallet
  records and the versioned backup codec.
- `ios/Transfers/`: bridge proposal validation, quote loading, native review text,
  Rust signing orchestration, encrypted journal and read-only reconciliation.
- `ios/UI/`: shared native confirmation and document-picker presentation.
- `ios/Support/`: named limits used by the native implementation.
- `ios/Tests/`: behavior-focused credential, backup, storage, authorization and
  transfer tests; `WalletTestCase` provides synthetic test fixtures only.

Follow transfers from `WalletCeremony+Transfers` into `TransferEngine.prepare`,
then native approval/passkey authorization and `TransferEngine.execute`. Fresh
signatures are durably journaled before submission. Explicit retries use the saved
bytes; reconciliation never broadcasts. Keep these ordering and cleanup boundaries
intact when refactoring. Journal states retain their existing serialized strings.

SwiftPM discovers the nested source folders; the podspec's recursive Swift glob
includes them as well. Keep `Generated/` separate and regenerate bindings rather
than editing them.

The production profile enables wallet access in Release
through the signed `GizuWalletEnabled` Info.plist flag (`Support/WalletBuildPolicy.swift`). It does not
expose debug screens or expand signing policy. Ordinary Release builds remain
unavailable without that flag. See [release prerequisites](../../README.md#production-builds-and-testflight-distribution).
