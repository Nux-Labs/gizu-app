# Retired signer reference

**Complexity: 2 — Technical.** [Signer overview](NATIVE_SIGNER.md).

**Historical, inactive implementation.** The policy, exports, dependency versions
and no-persistence rules below describe `gizu-signer`, not `GizuStoredSigner`.
They are retained for migration and security-decision context, not setup guidance.

## Retained signer reference (inactive)

The remaining sections document the preserved implementation, not current app
capabilities. Its no-secret-persistence/no-rebroadcast rules apply to that module;
the replacement intentionally changes those rules under the migration plan.

Original reference updated 2026-09-24; source retention/isolation reviewed
2026-11-14. Development implementation exists on
Android and iOS; full security/device acceptance is open. Dated results and acceptance gaps live in
[verification](NATIVE_SIGNER_VERIFICATION.md).

## Threat model and enforceable claim

Target: PRF, mnemonic, seed, extended private keys and child private keys never
cross into JS. The signer issues signatures only for the exact operation approved
through its native review. Treat all JS, request fields, backend responses and
RPC responses as untrusted inputs; distinguish RPC availability from consensus truth.

| Attacker/capability                                 | Required boundary                                                                                                       | Limitation                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Malicious JS/dependency/OTA JS update               | Cannot read secrets, approve a request, substitute signed bytes, exceed approved limits or call a second raw PRF bridge | Can mislead outside native review, request prompts, cancel or deny service                                          |
| Malicious backend                                   | No key material; supplied operation is parsed and reviewed natively                                                     | Can lie about product information; signer cannot establish investment legitimacy                                    |
| Malicious RPC                                       | Cannot choose signed chain/recipient/value beyond approved fields                                                       | Can lie about nonce/code/balance/receipts; N0 trusts configured RPC for chain-state observations, not authorization |
| Native memory corruption/instrumentation, rooted OS | Outside the claim                                                                                                       | Native secrets reside in app memory; Rust/zeroing reduce risks, not hardware isolation                              |
| Malicious signed native app update/build dependency | Outside runtime boundary                                                                                                | Requires build/release provenance and independent review                                                            |
| Domain/provider compromise, lost passkey            | Separate recovery/trust gate                                                                                            | Same RP is shared with web/dev; mobile isolation does not protect an exposed web PRF                                |

Native review is an app-controlled trusted surface relative to JS, not an
OS-attested transaction display. Prevent JS overlays/touch interception by using
a full-screen native controller/Activity, never a React view/WebView. User approval
must originate from that controller; no JS `approve` method/event. A counterfeit
JS screen cannot authorize the real signer, but social engineering remains possible.

## Ownership and public interface

The local Expo module contains Swift/Kotlin credential adapters, native review,
transport and storage. A shared Rust core owns derivation, immutable transactions,
policy, expiry and secret lifetimes. UniFFI is private native-to-native plumbing;
its objects and buffers must never be re-exported through Expo.

Current native exports are `getCapabilities`, `openWallet`, `openNativeProbe`,
`cancelProbe`, `executeOperation`, `getOperationStatus`, `cancelOperation`, `lock`.
These are retained native exports, not the active app API or the former N0
proposal. Historical adapters/interfaces remain under
`src/development/legacySigner/`; the active app boundary is
`src/domain/wallet/storedSigner.ts`. Source/generated ownership is documented in the
[module guide](../../mobile/modules/gizu-signer/README.md).

`openWallet` returns allowlisted public address, account index and chain ID after
native derivation; it does not sign. Wallet sessions are in-memory viewing access,
not backend authentication or reusable spending authorization. Only native review
can approve the private immutable operation; JS cannot approve, sign an arbitrary
digest, fetch PRF/private keys or receive raw signed transaction bytes.

## Frozen identity and bounded policy

Identity source: `src/config/passkey-identity.json`; setup and association files:
[passkey configuration](../app-guide/PASSKEY_CONFIGURATION.md). Preserve RP `gizu.io`, salt
SHA-256 of UTF-8 `mera.prf.salt.v1`, 32-byte entropy, English BIP-39 and empty
passphrase. Account 0 is `m/44'/60'/0'/0/0` (`mera-evm-v1`); native indexed derivation
uses `m/44'/60'/0'/0/i`, i=0..15 (`gizu-indexed-v1`). Main-app access exposes Account 0.
No JS-supplied RP, path, salt, mnemonic or extended-key export is allowed.
Development/web/mobile share the RP: use separate test credentials, not an assumed
isolated development wallet namespace. Web compatibility is not web secret isolation.

- Monad testnet only: chain 10143, native MON, 18 decimals.
- Up to 32 native transfer steps and indices 0..15. The diagnostic form limits its
  repeated batch to 16; the main app submits one Account 0 transfer.
- Per transfer <=0.1 MON; aggregate value <=1 MON; aggregate maximum fees <=0.1 MON.
- Strict bounded proposals (64 KiB), one active native ceremony/operation; reject
  unknown/duplicate fields, ambiguous amounts, unsupported accounts/chains/payloads.
- EIP-1559 native transfers only; no calldata/access lists, contract creation,
  ERC-20 approvals, ERC-4337, EIP-7702 or arbitrary message/digest signing. The
  diagnostic probe signs fixed test proofs only.
- Reject zero/low reserved recipients, executable sender/recipient code and gas
  estimates other than 21,000. Code checks are observations, not future guarantees.
- Main-app proposals bind `expectedFrom` to the displayed wallet; a different
  passkey-derived sender is rejected before approval/signing.
- Native provider waits and secret-bearing operations are bounded at 120 seconds.
  Core lifetime starts on PRF-backed operation creation; preparation/review consume
  that window. No sliding extension or resumed signing after process restart.

## Execution and recovery contract

1. Native full-screen UI asks to unlock an **existing** test passkey. Creation
   remains a deliberate action in the separate N1 probe.
2. The private Rust operation derives sender addresses from PRF and owns the seed.
   Native transport queries the pinned HTTPS RPC for chain, pending nonce,
   balances, gas estimate, fees and account code. No JS endpoints or headers;
   redirects are rejected and response sizes bounded.
3. Rust constructs immutable EIP-1559 transactions, allocates consecutive nonces,
   validates per-account aggregate debits and generates the full native review.
   Every source, destination, amount, nonce, gas, fee and aggregate maximum debit
   is displayed. Reading to the bottom enables native approval.
4. Only that native button approves the same operation object. Before each step,
   native code rechecks chain, pending nonce and account code. Rust signs each
   approved step once; changed nonce/chain/code invalidates remaining authority.
5. Before broadcast, native storage records chain, account, nonce, intent hash,
   expected transaction hash and operation ID. It never stores seed or signed
   transaction bytes. Native transport sends the signed bytes directly.
6. Native reconciliation checks receipts against canonical block hashes and the
   RPC's finalized height. Results distinguish `finalized`, `reverted`,
   `pending` and `unknown`. A returned broadcast hash alone is not finality.
   Sequential execution stops unless the preceding transfer reaches finalized
   success within the bounded polling window.

RPC chain state is trusted, not light-client verified. Native transport pins the
HTTPS Monad testnet endpoint and rejects arbitrary JS URLs/headers and redirects.
Review includes full sender/recipient, every step, exact value/nonce/gas/fees and
aggregate maximum debit; reading the details enables approval. Replacements or fee
changes require a new review. Sequential batches are not atomic.

Provider pauses are distinct from leaving the app: only a pending ceremony may
survive the provider UI, and foreground is required on return. Backgrounding during
preparation/review/execution, rejection, lock, expiry or teardown invalidates
remaining authority. Android uses a non-exported secure Activity with overlay
protection; iOS uses a full-screen UIKit controller. Neither is an OS-attested
transaction display. JS AppState never grants approval.

Journal writes precede broadcast and store public metadata only, including details
for new records. Older records may lack amount/recipient; never invent them.
Any pending/unknown record blocks new transfers, including across accounts and
restart. Refresh reconciles without unlocking; no automatic replacement, resend,
nonce reset or journal-clear escape hatch. Current capacity is 256 records.
Cancellation cannot undo a broadcast, and EOA signatures have no on-chain expiry.

Android preparation has cancellable transport, a 12-second call and 30-second
preparation deadline, a 1 MiB response bound, and explicit aggregate funding
feedback. These Android-specific refinements are not claims of identical iOS UX.

## Dependency and memory constraints

Direct core pins were checked against `core/Cargo.toml` during consolidation;
`Cargo.lock`, platform build files and the npm lockfile are authoritative for the
resolved graph. The original dependency/provenance decision is retained below;
its review obligations are not a completed audit.

| Component              | Selection / provenance                                                                               | License / review notes                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Public bridge          | Existing Expo 57-compatible `expo-modules-core`, Swift/Kotlin local module                           | Expo MIT; use installed SDK resolution, no independent latest upgrade                                                          |
| iOS credentials/UI     | Apple AuthenticationServices + UIKit, iOS 18+ PRF capability                                         | Apple SDK terms; PRF provider/device checks required                                                                           |
| Android credentials/UI | `androidx.credentials:credentials:1.6.0` and `credentials-play-services-auth:1.6.0`; native Activity | AndroidX Apache-2.0; native dependency pins; wider provider acceptance remains open                                            |
| Native bindings        | Mozilla `uniffi = 0.32.2`                                                                            | MPL-2.0; generated binding/license obligations require review before distribution; private native-to-native API only           |
| BIP-39                 | rust-bitcoin `bip39 = 3.0.0`, English, zeroize enabled                                               | CC0-1.0; don't enable random mnemonic generation or secret serialization                                                       |
| BIP-32                 | iqlusion `bip32 = 0.6.0`, k256 backend                                                               | MIT OR Apache-2.0; registry dependency is k256 ^0.14; inspect secret copies/chain-code cleanup                                 |
| secp256k1              | RustCrypto `k256 = 0.14.0`, ECDSA/recovery only                                                      | MIT OR Apache-2.0; upstream documents historical audit/fixed issues, not an audit of this version/integration                  |
| Ethereum codec         | Alloy `alloy-consensus = 2.5.0`, `alloy-primitives = 1.7.3`                                          | MIT OR Apache-2.0; native typed EIP-1559 encoding, no custom RLP/crypto; consensus declares Rust 1.94.1 minimum                |
| Cleanup                | RustCrypto `zeroize = 1.9.0`                                                                         | MIT OR Apache-2.0; explicit close and zeroizing owned buffers, not proof every copy is erased                                  |
| Public request parsing | `serde = 1.0.229`, `serde_json = 1.0.151`                                                            | MIT OR Apache-2.0; reject unknown/duplicate fields, floats, oversized/deep input; never derive Serialize/Debug on secret types |

Use platform randomness (SecRandomCopyBytes / SecureRandom), established codec and
signing APIs, and Keccak rather than SHA3 for Ethereum. No bespoke nonce/crypto.
Explicitly close operations and clear owned mutable buffers; UniFFI, provider JSON,
Swift/JVM copies and crypto temporaries prevent promises of total forensic erasure.
No secret persistence, logging, backup, export or debug API. Native memory is not
Secure Enclave/Keystore isolation. License/advisory and independent security review
remain release gates even when builds and synthetic tests pass.

## Retired JavaScript probe

Removed 2026-09-24; historical implementation is in Git at `50c52e9`. Its PRF,
derivation and signing entered JavaScript and must not return as a fallback.
The old `probe` mode is rejected. Rebuild installed native clients to remove old
bridges; Metro reload alone cannot prove their absence. Verify exports on both
platforms. Former public metadata key `gizu.mera.probe.metadata.v1` is untrusted
remembered data, never authentication. Retirement did not delete provider passkeys.

## Sources and reproducibility

Read on 2026-09-24; revalidate version-specific APIs before implementation.

- [Expo local native modules](https://docs.expo.dev/workflow/customizing/)
- [UniFFI guide](https://mozilla.github.io/uniffi-rs/latest/) and
  [object lifetimes](https://mozilla.github.io/uniffi-rs/latest/internals/object_references.html)
- [Mera security model](https://mera.category.xyz/concepts/security-model/)
- [Android Credential Manager](https://developer.android.com/identity/credential-manager)
- [Android Keystore limits](https://developer.android.com/privacy-and-security/keystore)
- [k256 security notes](https://docs.rs/k256/0.14.0/k256/)
- [BIP-32](https://docs.rs/bip32/0.6.0/bip32/), [BIP-39](https://docs.rs/bip39/3.0.0/bip39/)
- [zeroize limitations](https://docs.rs/zeroize/1.9.0/zeroize/)
- [Alloy consensus](https://docs.rs/alloy-consensus/2.5.0/alloy_consensus/)
- [Registry metadata](https://crates.io): `/api/v1/crates/{name}` and
  `/api/v1/crates/{name}/{version}/dependencies`; observed bip32 0.6.0 → k256 ^0.14.
- [Monad testnet information](https://docs.monad.xyz/developer-essentials/testnet)
- [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing)
