# Native storage, authorization and wallet recovery

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Reviewed against source on 2026-11-14; this is not new device, provider or security
verification. See [dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).
Both native codecs write backup version 3 and read versions 1–3. The
[TypeScript identity](../../mobile/src/domain/wallet/storedSigner.ts) still declares
version 2; it does not describe the current emitted file.

## Android shared private-read session

The in-memory `PrivateUsdcRead` grant is shared by Home, Earn private-balance
reads, payout reconciliation and cashout preparation. Normal wallet login
establishes read access. Ordinary app switching retains the grant; screen lock,
explicit wallet lock/sign-out, wallet identity or journal-generation changes,
and process restart revoke it. Screen-off and device-lock checks enforce that
boundary. The grant is never persisted across restarts.

Backgrounding still cancels network work and spending approvals. Feature-level
cancellation cancels operation authority without explicitly locking the wallet;
older native clients may fall back to full lock. Foregrounding refreshes through
the shared read grant without starting another passkey ceremony while it remains
valid. When locked, the UI offers **Unlock private balance**; a normal refresh
must not imply that every balance read needs authentication.

Spending remains separately reviewed and authorized per operation. The shared
read grant does not extend quote freshness, short-lived empty-intents RPC
authentication or financial approval lifetimes. This behavior applies to the
Android private-balance implementation; it does not imply equivalent iOS private
portfolio or Earn execution capabilities.

## iOS storage and authorization

The replacement includes a Swift Expo module backed by the stored-wallet Rust core.
Local AES-GCM records and the operation journal live in completely protected,
backup-excluded Application Support files. A non-synchronizing Keychain key uses
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`; missing keys require recovery,
not automatic wallet replacement. This protects storage at rest, not hardware-enforced
transaction authorization. Native code owns verification, approval and secret use.

AuthenticationServices registration/assertions are checked for the expected credential,
challenge, RP, `https://gizu.io` origin, presence, verification and P-256 signature.
Creation proves PRF availability before generating entropy. iOS uses the same backup
format versions and derivation, with a platform-local wallet record and journal format.
Document selection, save/reopen verification and restore remain native. Restore asks
for address confirmation without retaining entropy/PRF across that confirmation;
fresh PRF authorization commits the recovery. Initial acceptance is iPhone-to-iPhone;
Android/iOS recovery-provider interoperability is not yet accepted.

Native full-screen review uses the existing visual language and keeps Cancel available
through preparation. Exact-transfer limits, encrypted signed-before-broadcast journaling,
read-only reconciliation and explicitly authorized identical-byte retries match Android.
Capability adapters query native capabilities before entering each operation; module
presence alone is insufficient. Release availability requires the signed
`GizuWalletEnabled` build flag. Simulator checks
are separate from pending physical-device/provider and independent security acceptance.

## Verified backup and recovery

Native `BackupActivity` owns Android document selection, credential prompts and file IO.
It is not exported. A process-local operation token and the module mutex bind it to
one pending native request; recreation/process death requires restarting the ceremony.
An encrypted file is saved with `ACTION_CREATE_DOCUMENT`, reopened with
`ACTION_OPEN_DOCUMENT`, then decrypted using a fresh verified passkey PRF result.
Native comparison checks wallet identity, credential, entropy and all 16 derived
addresses before atomically persisting `ready`. Cancellation/failure preserves the
same wallet in `backupRequired`; repeating backup on a ready wallet preserves readiness.

Current version-3 backups encrypt a JSON payload containing entropy, role registry,
selected Earn chain, recovery gate, cycle index and cycle metadata using AES-256-GCM
and the 32-byte recovery PRF result as key. AAD binds format/version, RP, derivation
version, wallet UUID and credential ID/P-256 public key. Version 1 contains raw
entropy; version 2 adds the authenticated public role registry to its header/AAD.
Version 3 keeps that registry and Earn metadata inside ciphertext. Files are bounded
to 16 MiB on Android and 64 KiB on iOS; shared format does not imply equal capacity.
Backup plaintext and PRF never cross Expo. Owned buffers are cleared, but provider
and managed-runtime copies cannot be guaranteed erased. Save and reopen verification
use separate fresh passkey checks.

Android local binary storage writes version 6 and reads versions 1–6, including
both historical version-4 layouts. Version 6 carries the role registry, Earn state,
length-prefixed cycle catalogue and discovery high-water/recovery gate. Version-2
records retain readiness and use wallet UUID as journal generation; version-1
records load as backup-required without changing entropy. Restore requires the encrypted
file and its original passkey, validates authenticated metadata and derivation,
and re-encrypts under a local Keystore key. Only absent/unreadable storage can be
restored; readable wallets cannot be overwritten. The exported backup does not contain execution journals. Android can separately
restore synced authenticated history and allocation metadata through
[encrypted recovery sync](WALLET_DISCOVERY_RECOVERY.md); iOS does not advertise
that capability. Lost-passkey recovery and web sharing remain deferred.

The two-minute ceremony deadline includes document selection. Backgrounding outside
native credential/document UI cancels; foreground/unlocked checks apply on return.
Automated tests cover codec/storage and mocked app flows, not device/provider/file
picker acceptance or independent security review.
