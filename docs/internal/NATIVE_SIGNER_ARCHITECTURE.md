# Stored-wallet architecture

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

Reviewed against maintained native and TypeScript source on 2026-11-14. This is a
source description, not a new device, provider or security verification. See
[dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

## Stored-wallet boundary

`GizuStoredSigner` is the active Expo module, with Swift/Kotlin integration and a
shared Rust wallet/policy core. The retained `modules/gizu-signer` is excluded from
Android/iOS autolinking. Legacy JavaScript adapters under
`src/development/legacySigner` are inactive; app composition never chooses them.
Rebuild installed binaries after changing native registration.

Android wallet eligibility requires Android 9/API 28 and an Activity. The library
itself compiles with minSdk 24; that does not lower runtime eligibility. iOS wallet
access requires iOS 18+, and Release additionally requires the signed
`GizuWalletEnabled` flag. Storage, passkey access, verified backup, exact testnet
transfers, swaps and public portfolio reads exist on both platforms. Android also
advertises wallet recovery/discovery and the full guarded Earn deposit, funding,
private payout, partial withdrawal and confidential cashout capabilities. iOS
advertises confidential cashout, Earn wallets and Ethereum vault execution; other
Earn execution flags are false or absent. Both platforms advertise confidential
sale proceeds on eligible builds. Cashout requires its reported capability and
all five native methods. iOS cashout uses separate read-only authorization and
spending review; it does not add Android's shared private-read session. Always
check capabilities for each operation.

Only backup-verified `ready` wallets enter app sessions. Other states are `absent`,
`backupRequired` and `recoveryRequired`. Native owns credentials, secret material,
file selection, backup verification and financial approval. JavaScript requests
proposals and receives public metadata/status, never raw signed bytes or secrets.
`lock` revokes authority while retaining storage and broadcast evidence. Android's
`cancelWalletOperation` cancels feature work/spending authority while retaining a
valid shared private-read grant; explicit lock also clears that grant.

## Identity and derivation

- Storage namespace: `io.gizu.storedwallet.v1`; RP: `gizu.io`.
- Backup format: `gizu-stored-wallet`; both native writers emit version 3 and read
  versions 1–3. TypeScript's `storedSignerIdentity.backupVersion` still says 2;
  this is a source-contract discrepancy, not the current codec specification.
- Derivation identity: `gizu-stored-evm-v1`; recovery PRF salt is SHA-256 of UTF-8
  `gizu.stored-wallet.recovery-prf.v1`.
- Random 32-byte entropy uses English BIP-39, empty passphrase and
  `m/44'/60'/0'/0/i`. The exact MON transfer API limits indices to 0–15; the
  allocation registry supports additional public receiving indices. Account 0 is
  the app account, Account 1 public funding and Account 2 shared private USDC.
- Public recipients start at index 3, allocated monotonically and persisted before
  use. Swap allocation reserves blocks of three for 1–5 selected recipients;
  Earn may reserve individual withdrawal recipients.
- Original Earn cycle roles use `m/44'/60'/143'/{chainId}'/{role}`. Later cycles use
  `m/44'/60'/144'/{chainId}'/{cycleIndex * 3 + role}`. Distribution investment
  slots use `m/44'/60'/145'/{chainId}'/{cycleIndex * 8 + slot}`, slots 0–4.
  Chains 1 and 4663 are distinct. New cycles persist `privateAccount: "shared"`
  and use Account 2 for private cash; legacy identities and saved operations keep
  their original bindings.
- Sealed Strategies signing keys use `m/44'/60'/146'/{registryChainId}'/{index}` for
  registry chains 8453 and 84532 (`core/src/strategy.rs`). They hold no funds and
  only sign the registry's `CreateStrategy` and `Commit` structures for the pinned
  registry, which a relayer submits, the API-only
  `UpdatePrice(uint256 strategyId,uint64 version,uint64 monthlyPriceAtoms,uint64 signalPriceAtoms,uint64 deadline)`
  under the same registry domain, and the `OwnerLink` below. One wallet has one
  strategy: creation and price changes sign with index 0 only (Kotlin `require` and
  Rust `InvalidInput`). Commitments still accept any index for strategies created
  before that rule. No counter is persisted, so restore needs no metadata. The app shows the
  review's terms (name, prices, seats, embargo, network) and, for each update, every
  asset's pinned label and weight; Rust hashes and validates both before the passkey,
  and the approval is bound to those hashes. A price change reviews both new prices
  (each 0–999999999999 USDC base units, `version` ≥ 1, deadline at most an hour
  ahead) and binds the approval to
  `strategy-price:v1:{chainId}:{strategyId}:{version}:{monthly}:{signal}`. The leaf
  index is non-hardened, like the Earn branches; the xpub of `146'/{chain}'` never
  leaves native code.
- The Sealed Strategies social key uses `m/44'/60'/147'/{registryChainId}'/0`, only
  on chains with a pinned registry (84532 today; `core/src/social.rs`). It holds no
  funds and only identifies a commenter. It signs only
  `SignIn(address account,bytes32 nonce,uint64 issuedAt)` for its own address, and
  strategy key 0 signs only `OwnerLink(address account,uint256 strategyId,bytes32 nonce)`
  binding that address to an owned strategy, both under the domain
  `{ name: "GizuSocial", version: "1", chainId }` with no verifying contract. JS
  supplies only the backend's nonce, its `issuedAt` (rejected when more than ten
  minutes from the device clock) and the optional strategy id; the approval is bound
  to `social-signin:v1:{chainId}:{nonce}`. Reading the social address needs no
  passkey. `shared/strategy-social-vectors.json` holds cast-computed addresses,
  digests and signatures for all three new structures.

Passkeys authorize use of randomly generated local entropy; PRF encrypts backups
and does not determine addresses. Old signer state/provider passkeys are neither
deleted nor migrated. Home's Monad mainnet portfolio does not expand the separate
chain-10143 MON transfer policy. Mainnet operations use their own native policies.
Android encrypted recovery sync can restore authenticated allocation/journal
metadata after entropy restore; a backup alone does not recover local history.
Web wallet sharing and lost-passkey recovery remain deferred.
