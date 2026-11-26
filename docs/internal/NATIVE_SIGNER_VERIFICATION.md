# Native signer verification

## Funding expansion verification (2026-11-26)

Implementation revision: `1bf739d` on `feat/funding-expansion`.

The `feat/funding-expansion` implementation extends Account 1 funding to Base
and Arbitrum and combines confirmed credits at Account 2 before using the existing
private-funded Earn or Swap action. The amount entered remains the gross budget,
including fees. iOS guided Earn availability is unchanged.

Recorded local checks for this implementation:

- Pinned Rust 1.94.1: 286 tests passed. Android arm64 and iOS device/simulator
  libraries, host library and UniFFI bindings regenerated with that toolchain.
- Backend: 551 passed, 13 skipped, zero failures; TypeScript and both gas-policy
  checks passed. Skipped provider/Postgres cases are not funded or database proof.
- Android signer: 637 Debug and 637 Release unit tests passed; both library
  variants built. Tests exercise maintained Kotlin and the actual Rust host
  library, including mixed-network recovery and bounded private handoff.
  The complete arm64 Debug app also built successfully. APK inspection includes
  `libgizu_stored_signer_core.so` and excludes the retired Gizu signer. APK SHA-256:
  `7bfb31ed15e5f717dfdf8a2675de469f8f7c606d931ffaa5d02657062f8ac56f`.
- Maintained Swift native sources: 111 portable tests passed against the Rust
  host library; iOS device-SDK typecheck passed for native and UI classes.
  The portable harness excludes Apple-service-dependent diagnostics tests.
- iOS prebuild, CocoaPods installation and stored-signer-only registration check
  passed. The complete unsigned app build could not select an eligible iOS
  destination. Building the signer Pod directly then stopped in the existing
  ExpoModulesJSI dependency: it requires Swift tools 6.2, while installed Xcode
  provides 6.1. Full Expo module/app compilation is therefore unverified.
- Mobile JavaScript: 1,191 tests passed across 116 suites with coverage enabled.
  TypeScript, formatting and lint passed. `npm run check` stops at Expo Doctor
  (20/21) because the existing installed Expo, dev-client and splash-screen
  versions are one patch behind its recommendations; coverage was run separately.
  This feature does not update those dependencies.

The independent final correctness review found no remaining actionable P1/P2
findings. This does not establish funded provider or physical-device acceptance.
No transaction, deployment, push or merge was performed. Default backend funding
admission remains Monad; development qualification explicitly enables
`FUNDING_CHAIN_IDS=143,8453,42161`. Ethereum private-funded Earn also requires its
explicit fee-policy qualification. See
[network enablement and rollback](BACKEND_RUNTIME.md#funding-network-enablement).

Before general enablement, run funded Base/Arbitrum single-source and mixed-source
journeys, real gas/fee and private settlement/refund checks, and device background,
process-death and Resume checks. This is qualification of the new networks; it
does not invalidate the existing Monad flow. Full simulator execution is unavailable
on this host because no iPhone simulator runtime is installed.

Historical evidence consolidated on 2026-10-08. Source references reviewed on
2026-11-14; no native builds, application suites or live/device checks were rerun
for this documentation review.
Counts describe the recorded revisions, not current suite totals. Replacement and
retired signer results are separated because they prove different boundaries.
Later dated Earn/withdrawal evidence is maintained in
[Confidential Earn](CONFIDENTIAL_EARN.md) and
[confidential withdrawals](CONFIDENTIAL_WITHDRAWALS.md#recorded-verification).
These records do not establish full iOS/Android parity or independent security
acceptance. Current architecture: [signer overview](NATIVE_SIGNER.md). Setup:
[local development](../app-guide/MOBILE_LOCAL_DEVELOPMENT.md).

## Current maintainer-confirmed status

On 15 November 2026, the maintainer confirmed that physical-iPhone testing is
complete and that AWS deployment and networking are configured. The API is
`https://api.gizu.io`. This supersedes the blanket iPhone acceptance and deployment
gaps in the older records. No new test runs are recorded here; historical records
retain their original dates and scope. Cross-platform backup interoperability and
independent security review remain separate requirements.

The subsequently integrated iOS public-cashout implementation has its own funded
physical-iPhone acceptance requirement. The earlier device confirmation does not
establish live settlement for that new feature; see
[cashout deployment and limits](CONFIDENTIAL_WITHDRAWALS.md#deployment-and-limits).

## Stored-wallet implementation evidence

| Date / slice                   | Recorded verification                                                                                                                        | Limitation                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-25 isolation           | 182 Jest tests/25 suites; Android arm64 build and binary inspection excluded the retired signer; autolinking excluded it on both platforms   | Replacement was contract-only then; no iOS rebuild/device test. Expo Doctor external metadata/DNS checks failed.                                                                                          |
| 2026-09-25 storage             | 11 Rust tests and Clippy; 12 JVM tests; 21 focused app tests; APK inspection confirmed replacement-only registration                         | User-reported create/open/cancel/restart; no Keystore instrumentation or backup/transaction acceptance at this stage.                                                                                     |
| 2026-09-25 backup              | 18 JVM tests, 193 Jest tests/28 suites and focused five-test onboarding suite; arm64 build                                                   | Tampering, wrong PRF, healthy-wallet overwrite and old storage compatibility covered. User reported backup/reconnect success; lock and second-device restore unverified.                                  |
| 2026-09-25 transfers           | 27 JVM, 206 Jest/30 suites, 11 Rust and 12 focused transfer tests; arm64 build                                                               | Covered lost responses, exact-byte retry, nonce conflicts and stale revisions. User reported cancellation/withdrawal/history/background checks; multi-step and uncertain-submission hardware checks open. |
| 2026-09-25 durable writes      | 32 JVM tests and arm64 build; sync/close/rename/directory-sync/read-back failure injection, archive failures and unresolved-record retention | Asserted no broadcast after commit failures. No device filesystem fault injection; JS/Rust unchanged and not rerun.                                                                                       |
| 2026-09-28 iOS                 | 10 native simulator, 33 Android JVM, 11 Rust and 237 JS tests; iOS device/simulator libraries and unsigned simulator app built               | Registration/Pods/symbol inspection included only stored signer. No physical iPhone, provider, Files or recovery acceptance; no transaction sent.                                                         |
| 2026-09-28 Release preparation | 249 app tests, 13 Release native tests, coverage/type/lint/format, Expo Doctor 21/21 and unsigned iPhone Release archive                     | Test-only visibility used for tests, not app archive. No distribution or signed-device/provider proof.                                                                                                    |

The iOS tests covered assertion rejection, corrupt storage/missing key, shared
backup/derivation fixtures, expiry/cancellation, restart, stale revision and
identical-byte recovery. Android and iOS shared backup fixtures, but this did not
establish cross-platform provider recovery compatibility.

Historical tool failures included Expo 57.0.24 versus expected 57.0.25 and an unused
`colors` import in `WaveBackdrop.tsx`; these are dated observations, not current
bugs. Local CI configuration/builds did not establish a remote CI run.

## Superseded release configuration

September 28 used a testnet-only Release flag and recorded pending signing,
association and distribution setup. September 30 replaced that flag with
`GizuWalletEnabled`, shared production/TestFlight identity and `gizu.io`.
Do not apply the older release instructions or treat their pending deployment
statements as current. Current identities and signing procedure live in
[passkey configuration](../app-guide/PASSKEY_CONFIGURATION.md).

## Retired signer automated evidence

| Slice, 2026-09-24    | Recorded checks                                                                                                                                                                     | Scope limitation                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| N1                   | 4 Rust tests, formatting/Clippy, independent viem recovery of 16 synthetic signatures, 123 Jest tests/15 suites, coverage, TS/lint, Android arm64 and unsigned iOS simulator builds | No physical iOS, secret-boundary instrumentation or audit                         |
| N2                   | 10 Rust tests, synthetic EIP-1559 decoding/hash/signer checks, 138 Jest tests/17 suites, coverage and both builds                                                                   | Native review implemented; hostile-bridge acceptance incomplete                   |
| N2 follow-up         | 12 Rust tests, 8 Android JVM tests, 25 focused Jest tests, TS/scoped lint, arm64 APK                                                                                                | Transport/funding/cancellation checks; no new iOS or 13-transfer acceptance       |
| N3 access            | 13 Rust tests, 157 Jest tests/19 suites, coverage, native bindings, Android JVM/build and unsigned iOS simulator                                                                    | Mocked access tests do not establish provider behavior                            |
| N3 transfers/history | 14 Rust tests, 170 Jest tests/21 suites, coverage, TS/lint/format, Android JVM/build and unsigned iOS simulator                                                                     | Live approval through the newly integrated screen not established by installation |

Synthetic checks use reference inputs only, never real passkey secrets in JS.
The transfer vector example and `scripts/verify-transfer.mjs` independently decode
and recover native outputs. CI native generation/build configuration exists;
local results do not establish hosted CI/Linux success. CI's ephemeral Android
signing key must not be published in domain associations.

Previously recorded failure: Expo Doctor 20/21, installed Expo 57.0.24 versus
expected 57.0.25. This is historical until rerun, not a newly observed result.

## Retired signer physical Android evidence

N1 user reported success on A142 / Android 16. Provider identity, exact revision,
prompt count and boundary instrumentation were not fully recorded.

N2 user completed a 0.001 MON transfer after funding Account 0. Historical read-only
RPC checks confirmed successful receipt, chain 10143, 21,000 gas and a block below
the finalized head:

- Sender: `0x90ad2f19302ED5439B69659Bbc5D6d8c5b7dDf95`
- Recipient: `0x0e4e77B43a94A704E2a7a005238038F3EF00f407`
- Hash: `0xb3b9b115ec88086227c30cb712ba832b3604b2baaae771d9b70bf1b4ddbe9cb6`

User reported one unlock and one native approval for two further 0.001 MON transfers.
Historical RPC checks confirmed the same sender/recipient and consecutive nonces 1, 2:

- `0x6f67dafae7bb847dae6e6a1c6ebda51947fc98eccfc46e0c83028962252eee97`
- `0x1bd53bddc7b452dac29f69ce1de2ab5e9ad357275d11dd84bf942ed090602bdb`

User reported three finalized records after reopening and still three after
cancelling before approval. This supports completed-record persistence and one
cancellation case, not process-death safety during uncertain submission.
N3 screenshots showed a different zero-balance account and recovery of the funded
Account 0 with 19.990574 testnet MON: Android access/balance evidence only.

Earlier 2026-09-23 JavaScript-probe success proved derivation/recovery/test signing
on one provider; it does not prove the replacement native secret boundary.

## Retired signer main-app evidence

At that revision, Home, Account, Deposit/Withdraw and Activity used native adapters. Functional
coverage mocks those boundaries and exercises validation, duplicate prevention,
status display, missing legacy details, refresh failure, leaving a page during an
operation, disconnect and stale results. Native-only signing policy is unchanged.
Main-app physical acceptance was outstanding in that record; debug-harness
evidence did not complete it. The later maintainer-confirmed status is recorded above. Installation/build success is not an accepted live journey.

## Historical acceptance gaps

These were open in the original records. They are not a current release-blocker
list. The 15 November 2026 maintainer confirmation above supersedes the blanket iPhone
gap; the original records below retain their scenario-specific evidence limits.

- Physical iOS PRF create/open/recovery, review, cancellation and provider behavior.
- Android provider/device/revision/prompt record and native synthetic-secret
  instrumentation across returns, events, errors, logs and generated bindings.
- Hostile JS: removed bridge/secret exports inaccessible; no approve bypass, altered
  chain/recipient/value/fees/index, extra steps, replay, expiry or concurrent escalation.
- Review accessibility, overlay/touch protections, provider pauses versus background,
  teardown and late callbacks on both platforms.
- 13-transfer one-unlock batch: not run. Synthetic 16-signature proof is different.
- Partial-batch cancellation and uncertain-submission restart: not run. Preserve
  already-broadcast hashes, stop remaining authority, reconcile without resending.
- Insufficient funds on an unfunded account: explicit device acceptance still open.
- Independent FFI/memory/dependency/license/update-trust review and security audit.
- Signed production builds, recovery/domain loss/account discovery, web isolation
  and privacy decisions before real-funds release.

Record future results with revision, device/OS/provider, build type, prompts and
public hashes/statuses. Never capture real credential secrets or heap dumps.
