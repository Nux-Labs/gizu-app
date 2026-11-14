# Android stored-wallet signer migration

Agreed 2026-09-25; revised to preserve the existing signer module.
Status: phases 1–4 implemented. Android onboarding requires a saved and reopened
encrypted backup before app access. Withdraw and Activity use native exact-transfer
approval, encrypted operation history and explicit resume. The user reported phase-3
onboarding/backup checks passed. Guided phase-4 cancellation, withdrawal, restart and resume checks were also
user-reported successful. Extended device failure-path checks, second-device restore
and phase-5 validation remain pending. Android APK exclusion and iOS simulator binary exclusion are verified; physical iOS
acceptance remains unverified. Existing installed clients require rebuilding.

The original Android-only scope below is retained as migration history. The iOS
replacement is now implemented; current platform behavior and pending acceptance
are documented in [the native contract](NATIVE_SIGNER.md).

## Current interpretation (source review 2026-11-14)

The plan below records the 2026-09 Android milestone, not today's full capability
list. Both native platforms implement stored-wallet storage, backup, exact testnet
transfers, swaps and public portfolio reads. Android now adds encrypted recovery
sync/discovery, distributed Earn/private funding, partial Robinhood exits and
confidential cashout; iOS exposes Earn wallets and Ethereum vault execution while
its other Earn execution capabilities remain disabled. Native backup writers emit
v3/read v1–3, despite the TypeScript identity's remaining v2 constant. The native
wallet namespace and entropy derivation remain distinct from the retained signer.

Backup-only restore starts a fresh local journal generation. Android's separate
encrypted recovery service can import authenticated signed history; the original
phase-4 no-history statement below refers to entropy-file restore by itself.
Read authorization also evolved: ordinary app switching retains Android's
shared private-read grant, while spending work/approvals are cancelled. Lock,
sign-out and restart clear that grant. Full financial native reviews can use a
separate five-minute reading window; original two-minute wallet/exact-transfer
ceremonies are not a universal Earn timeout.

Use [architecture](NATIVE_SIGNER_ARCHITECTURE.md),
[storage](NATIVE_SIGNER_STORAGE.md) and [Earn](NATIVE_SIGNER_EARN.md) for current
source behavior. Historical test/device evidence above is preserved without
claiming new builds or live acceptance.

## Summary

Replace the current passkey-derived wallet model with randomly generated wallet
entropy encrypted locally. Reuse our Rust derivation and transaction-policy core;
adapt the research prototype's Android passkey authorization, encrypted storage
and backup/restore approach.

This is a development reset: no existing-user migration, address compatibility or
permanent secondary signer option in the app. Preserve `mobile/modules/gizu-signer`
as an inactive, independently buildable implementation for possible future reuse;
do not delete it or rewrite it into the replacement. Keep existing Gizu screens. Android is the only
supported signing platform for this phase; iOS must show explicit unavailability.

During implementation, update [the native contract](NATIVE_SIGNER.md) to reflect
the new architecture. Preserve historical verification separately and leave
`research/combined-wallet-prototype` unchanged.

## Agreed architecture and behavior

- Generate 32 random bytes natively. Preserve BIP-39/BIP-32 derivation and account
  indices 0–15, with Account 0 exposed in the main app. New entropy means new addresses.
- Encrypt wallet entropy in Android-private storage using an Android Keystore
  AES-GCM key. Passkey authorization is enforced by native application logic;
  do not claim hardware-enforced spending approval.
- Keep entropy, PRF, derived keys and backup plaintext outside JavaScript. Rust
  owns short-lived secret-bearing operations; no general-purpose signing or export bridge.
- Keep RP `gizu.io`. Introduce versioned stored-wallet and backup formats with an
  application-specific recovery PRF salt, distinct from the retired derivation salt.
- Use the registered passkey's verified assertion to authorize spending. Validate
  credential ID, challenge, origin, RP hash, user presence, user verification and
  signature natively.
- Bind authorization to the immutable operation and its revision. Approve exact
  transactions, including sender, recipient, amount, nonce and fees.
- Retain Monad testnet native-token transfers, existing limits, sender binding and
  finality checks. No contract calls, mainnet or new investment integrations.
- Retain a two-minute secret-bearing operation lifetime. Backgrounding outside
  the credential ceremony, device lock, cancellation or expiry ends authority;
  no background signing.

## Implementation phases

### 1. Freeze contracts and disconnect the old signer from the app

- Update architecture documentation, capability reporting and app-facing types
  for the stored-wallet model.
- Keep the app's service-adapter boundary, but use a separately named replacement
  native module with distinct native registration and storage identities. Add typed wallet
  lifecycle, backup/restore and operation-resume capabilities; return public metadata only.
- Model wallet state as absent, backup required, ready or recovery required.
  Never regenerate a wallet automatically after storage failure.
- Separate new storage from legacy metadata and journals. Do not delete provider
  passkeys or silently sweep development funds.
- Remove the old signer's app adapters, route/debug-harness wiring and automatic
  build integration. Exclude it from app native linking and registration on both
  platforms; removing JavaScript imports alone is not sufficient.
- Preserve the existing module's Android/iOS source, Rust core, bindings, tests,
  module-local build scripts and documentation. Keep standalone build/test commands
  available and document deliberate reactivation; no runtime selector or fallback.
- Disable iOS signer access without a fallback to the old model. The retained
  iOS implementation remains inactive source, not an available app capability.

### 2. Implement native wallet storage and passkey authorization

- Adapt prototype components into the new native module rather than
  importing the research application.
- Register a passkey, generate wallet entropy and atomically persist the encrypted
  wallet with credential verification data and derivation version.
- Reuse the existing Rust derivation and policy code in the replacement core,
  adapting its entrypoints to native-owned wallet entropy. Preserve the original
  module's behavior and independent build; avoid a shared-core refactor in this phase.
- Decrypt secrets only for native operations that need them; clear owned buffers
  and close operations on every terminal path.
- Serialize native wallet mutations and ceremonies. Normalize errors before
  returning them to JavaScript.

### 3. Require verified backup during onboarding

- Extend existing access onboarding with native backup creation. Wallet creation
  remains incomplete until verification succeeds.
- Require fresh passkey PRF access, encrypt a versioned backup containing wallet
  entropy and derivation metadata, then save through Android's document picker.
- Ask the user to reopen the saved file. Decrypt it natively and confirm that it
  recreates the same accounts before marking the wallet ready.
- Cancellation or failure leaves the same wallet in “backup required”; retry
  must not generate new entropy.
- Restore from the encrypted file using the original passkey. Validate format,
  RP, credential and derivation metadata; recreate local encrypted storage and
  verify addresses.
- Integrate backup management into Account. Restore is available when no usable
  wallet exists; never overwrite a healthy wallet implicitly.
- Clearly explain that recovery requires both the backup and original passkey.
  Web sharing and lost-passkey recovery are deferred.

### 4. Integrate exact transfers and explicit resume

- Reuse existing Withdraw, native review and Activity screens. Preserve Deposit's
  existing address presentation after onboarding completes.
- Persist operation IDs, revisions and individual transfer states. Store signed
  bytes encrypted before broadcast to support identical-byte retries.
- On interruption or restart, reconcile receipts and nonces before offering
  resume. Never automatically rebroadcast or continue signing.
- Resume requires fresh native review and passkey authorization. Retry an already
  signed transfer using exactly the saved bytes; never silently replace fees,
  recipients, values or nonces.
- If unsigned transactions no longer match their approved preparation, stop and
  require a newly prepared review after unresolved transactions are reconciled.
- Cancellation stops remaining execution but preserves submitted/uncertain
  records. Signed transactions cannot be revoked by local expiry.
- Restored wallets start with no local operation history and must not claim to
  recover an interrupted batch from the old device.

### 5. Validate replacement and retained-module isolation

- Remove obsolete app-facing access paths and bridge adapters once the replacement
  works; retain the old module's own exports and implementation for future reuse.
- Keep one active app signer and hidden diagnostics for the replacement. Verify
  that app builds do not include or register the retained signer.
- Update setup instructions, architecture and verification evidence. Clearly
  distinguish implemented behavior from device-tested acceptance.

## Test and acceptance plan

- **Core:** deterministic entropy-to-address derivation, exact-transaction
  immutability, limits, expiry and prevention of arbitrary signing.
- **Authorization:** wrong credential/origin/RP/challenge, invalid signature,
  concurrent prompts, stale approval and attempts to substitute operation revisions.
- **Storage:** authenticated encryption, corruption, unavailable Keystore key,
  atomic-write failure and no secret-bearing JavaScript responses.
- **Backup:** save/reopen verification, cancellation, tampering, wrong passkey,
  unsupported version, interrupted onboarding and second-device restore with
  identical addresses.
- **Transactions:** successful transfer and batch, insufficient funds, duplicate
  submission, lost broadcast response, identical-byte retry, nonce conflict,
  finality and partial-batch interruption.
- **Lifecycle:** backgrounding, lock, expiry and process termination require new
  authorization; none silently resume.
- **Application:** existing access, Home, Account, Deposit/Withdraw and Activity
  flows use the new adapter; unfinished backup blocks entry to the usable wallet.
- **Isolation:** app source and diagnostics cannot call the retained signer;
  native linking/registration inspection confirms its absence from rebuilt app
  binaries. Its module-local build/tests remain usable separately. Rebuild installed
  clients; a JavaScript reload cannot remove a previously linked native module.
- **Physical Android acceptance:** verify one approval/unlock for a multi-transfer
  batch within two minutes, explicit resume after interruption, and backup
  restoration on another device. If the second device is unavailable, record
  that acceptance as blocked rather than complete.

## Defaults and limits

- Fresh development wallets only; no automated migration or deletion of old funds.
- Retain existing account and transaction limits rather than copying the
  prototype's six-account/local-chain restrictions.
- No permanent signer selector, new standalone wallet UI, custody service,
  cloud backup service or web implementation.
- This is an Android development milestone, not production security acceptance.
  Independent review and iOS implementation remain subsequent work.
