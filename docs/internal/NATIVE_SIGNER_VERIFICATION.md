# Native signer verification

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
Main-app physical acceptance remains outstanding; debug-harness evidence does not
complete it. Installation/build success is not an accepted live journey.

## Historical acceptance gaps

These were open in the original records. They are not a current release-blocker
list; later acceptance must be established from dated evidence, not inferred.

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
