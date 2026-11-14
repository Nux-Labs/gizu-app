# GIZU-1 — Shared Monad portfolio read for iOS and Android

Status: implemented; physical-iPhone acceptance pending.  
Historical implementation branch: `feat/GIZU-1`.

Implementation and verification: 2026-10-02. No upload or deployment performed.

This is the historical GIZU-1 task and its dated verification record. Its public-USDC
acceptance scope is narrower than the current portfolio. For current owned-token,
confidential-cash, valuation and vault-position behavior, use
[the portfolio contract](../internal/NATIVE_SIGNER_PORTFOLIO.md) and
[product capabilities](PARITY.md). Source reviewed 2026-11-14; no historical check
below was rerun for this documentation update.

## Task definition

GIZU-1 closes the missing iOS public-wallet balance read and establishes shared
portfolio rules for both mobile platforms. Before this change, Android supplied a
Monad USDC snapshot to Home but iOS did not register `getMainnetPortfolio`; Home
reported that an updated native build was needed instead of showing balances.

The implementation moves public account selection, exact balance parsing,
aggregation and snapshot construction into the existing Rust core. Swift and
Kotlin become adapters that load the device's wallet, make read-only RPC requests
and return the shared result through their Expo modules. This avoids implementing
the same financial rules twice and lets both platforms use identical test fixtures.

Unification is limited to the public Monad USDC portfolio in this task. Wallet
storage, passkey providers, native approval UI and lifecycle handling remain
platform-specific. This is not a rewrite of the complete signer or an attempt to
enable every Android wallet feature on iOS.

## Planned feature and user experience

After opening an existing, backup-verified wallet, a user on either iOS or Android
will see the following in the existing Home wallet section:

- **Total Monad USDC:** the exact sum of balances across the included public wallets.
- **Funding balance:** the USDC balance for the wallet's designated funding address.
- **Receiving balance:** the remaining included public-wallet USDC, using the
  account-role semantics agreed in implementation step 1.
- **Refresh:** reloads those balances from Monad mainnet and updates the same section.

The initial load uses the same path as Refresh. A genuinely empty portfolio shows
zero; unavailable or invalid RPC data shows an error rather than a fabricated zero.
On refresh failure, retain the previous successful snapshot and show the failure.
Logout, wallet replacement or cancellation must prevent a late result from being
shown for the wrong session.

Users do not create another wallet, move funds, approve a transaction or visit a
new screen to use this feature. Reading public balances must not confer signing
authority. Existing platform security and verified-backup requirements still apply.

## Shared implementation boundary

| Responsibility                                                 | Owner                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Public account selection and derivation rules                  | Rust core, using the saved wallet registry                            |
| Token-balance decoding, exact arithmetic and total consistency | Rust core                                                             |
| Public snapshot data model and deterministic fixtures          | Shared Rust/UniFFI contract and existing TypeScript interface         |
| Wallet record access, secret lifetime and secure storage       | Swift / Kotlin                                                        |
| RPC networking, timeouts and cancellation                      | Swift / Kotlin adapters                                               |
| Existing Android balance cache and additional portfolio fields | Android; preserve behavior outside the extracted public-balance rules |
| Home rendering, session binding, loading and refresh           | Existing shared React Native provider and screen                      |

Use the existing Rust and UniFFI toolchain; add no new backend or dependency by
default. The Swift and Kotlin bindings are generated from the shared source.
Platform-specific transport differences may affect freshness, but must not change
account selection, amount interpretation or aggregation rules. Explicitly retain
Android's incomplete/stale cache states; do not label partial data as complete.

## Goal and acceptance

Implement iOS `getMainnetPortfolio()` so the existing Home screen displays public
Monad mainnet USDC total, funding balance and receiving balance. Initial loading
and Refresh must use the same native reader. A supported, successfully loaded
iOS build must no longer show “Mainnet balances need an updated native build on
this platform.” Genuine errors must remain visible rather than becoming zero balances.

This is read-only integration, not a new wallet UI or a signing-policy change.

## Starting evidence (before implementation)

- `src/services/wallet/nativeBridge.ts`: `getStoredSwapSigner().getMainnetPortfolio()`
  already queues native reads, checks wallet-storage capability and detects a missing method.
- `src/domain/wallet/storedSigner.ts`: `MainnetPortfolioSnapshot` defines the public contract.
- `src/features/wallet/MainnetWalletProvider.tsx`: initial load and refresh already
  call the bridge. Validation binds wallet ID and funding address to the session,
  requires chain 143 / USDC / 6 decimals, and checks exact totals using `BigInt`.
- Android `GizuStoredSignerModule.kt` registers the method, requires a verified
  wallet and uses `swap/MainnetPortfolio.kt`, `OwnedAccounts.kt` and
  `portfolio/TokenBalanceSync.kt` for public balances.
- Android now also adds owned assets, positions and confidential observations.
  Those extensions exceed this task's public Monad USDC acceptance criteria.
- iOS `GizuStoredSignerModule.swift` has no portfolio registration. It already has
  a serialized, cancellable native ceremony wrapper and encrypted wallet storage.
- iOS `Swap/SwapStore.swift` saves an active swap, but is not Android's persistent
  portfolio-history/cache implementation. Do not assume those stores are equivalent.
- iOS `Transfers/MonadRPC.swift` is pinned to Monad **testnet**. Do not repoint it
  to mainnet: existing transfer policy must remain unchanged.

## Scope

Include native iOS registration, shared Rust public-portfolio logic, migration of
Android's corresponding rules to that logic, read-only mainnet RPC adapters,
existing Home integration, cross-platform regression tests and parity documentation.
Reuse Rust derivation and the installed wallet record. Preserve Android's cache,
additional assets and history while extracting only the public-balance rules.

Exclude confidential balance authentication, other chains/assets, Earn positions,
USD pricing, transaction submission, new backend endpoints, new UI, historical
transaction indexing and migration of Android's entire portfolio subsystem.
No passkey bypass, new signing authority or export of entropy/private keys.

## Implementation order

### 1. Freeze account and snapshot semantics

Read the current Android reader and shared validator together; capture a shared
fixture for account indices, addresses, balances and totals before writing Swift.

- Mainnet chain: `143`; RPC: `https://rpc.monad.xyz`.
- USDC contract: `0x754704bc059f8c67012fed69bc8a327a5aafb603`; decimals: `6`.
- Enumerate only public accounts from the stored role registry: Android currently
  uses indices `0`, `1`, and `3..<nextRecipient`, bounded by `8192`. Exclude index
  `2` and unallocated indices. Derive with Rust; never accept arbitrary JS addresses.
- Confirm index `1` is the session funding address on iOS, including restored wallets.
- Resolve one existing Android inconsistency explicitly: both indices 0 and 1 have
  role `funding`, but `fundingAtoms` contains only index 1 and `returnAtoms` includes
  index 0. Test with a nonzero index-0 balance. Default to matching Android's wire
  totals for this ticket; document that `returnAtoms` means all other included
  public balances. If product semantics must change, agree a separate shared fix
  before changing Android or labeling account 0 as a receiving wallet.
- Keep amounts as canonical unsigned decimal strings. Totals must equal the sum
  of included account rows; no floating-point conversion or fixed-width overflow.
- Set `checkedAt` in milliseconds and `block` to the block used for all balance reads.
- Preserve required `history` shape. Return an empty history when no supported
  history source exists; do not invent or reconstruct successful transactions.
- Omit unrelated optional owned-asset fields. Do not report valuation or portfolio
  completeness for assets outside this reader's scope.

Exit: agreed fixtures pass the existing JavaScript snapshot validator.

### 2. Implement shared rules and native readers

Implement pure portfolio rules in the Rust core and expose them through UniFFI.
Move Android's public account/balance aggregation rules onto this implementation
without replacing its cache or additional portfolio layers. Add a focused Swift
adapter under `ios/Portfolio/` using the same generated bindings. Inject the RPC
boundary and clock where useful for tests; keep Expo registration thin.

- Use a dedicated read-only mainnet transport, reusing safe HTTP machinery where
  practical without changing `StoredMonadRPC`'s transfer endpoint.
- Validate chain ID, JSON-RPC response IDs/errors and result types. Obtain one block
  number and issue USDC `balanceOf` reads against that block.
- Bound request concurrency, batch sizes, account count and overall duration;
  propagate task cancellation into network requests. Avoid thousands of serial
  requests or unbounded fan-out for heavily allocated wallets.
- Require correctly encoded unsigned 256-bit token balances. Reuse Rust's existing
  exact integer types for conversion and aggregation; reject overflow explicitly.
  Do not add duplicate decimal arithmetic implementations in Swift and Kotlin.
- On iOS, initially return only complete successful snapshots (`balanceComplete: true`,
  `stale: false`, `syncPending: false`). If any required account read fails, fail
  the refresh and let the existing provider retain its previous snapshot. Never
  silently count an unknown balance as zero.
- Porting Android's persistent cache/incremental sync to iOS is deferred; preserve
  Android's existing freshness/completeness behavior. Verify bounded complete
  reads are practical at the supported account limit; if not, stop and agree an
  explicit staged-sync contract instead of reporting partial totals as complete.

Exit: deterministic tests cover account enumeration, fixed-block RPC reads and
exact snapshot construction independently of Expo and a real passkey. Both native
adapters produce identical financial results for identical complete observations.

### 3. Register and connect the native method

Register `getMainnetPortfolio` in `GizuStoredSignerModule.swift` through the existing
serialized ceremony/lifecycle wrapper. Load the existing wallet, require verified
backup, release sensitive buffers and return public snapshot data only.

- Read operations must not create/replace wallets, allocate recipients, submit
  transactions or establish reusable signing authority.
- Preserve lock/background/cancellation behavior and prevent late results from
  updating another session. Inspect the existing Home provider's session lifetime;
  add a generation guard only if its current ownership permits stale publication.
- Keep the existing public method signature and Home layout. The runtime missing-
  method check remains useful for older installed binaries; do not merely hide it.
- Confirm initial load, manual refresh and foreground refresh all reach this method.
- Check release eligibility with `GizuWalletEnabled` and the minimum supported iOS
  version. Keep unrelated unsupported iOS capabilities disabled.

Exit: existing Home shows totals and breakdown with an injected iOS native bridge;
refresh replaces them and failure preserves the last successful snapshot.

### 4. Verify and document

Shared Rust and native adapter tests:

- Run identical account/balance fixtures through both platform bindings and compare
  all public financial fields. Test partial/stale Android observations separately
  so the extraction cannot silently change existing cache semantics.

- Zero, funding-only, receiving-only, multiple allocated accounts, nonzero index 0.
- Exclusion of confidential/unallocated accounts; invalid registry and account limits.
- Large balances beyond JavaScript safe integers, exact sums and invalid RPC hex.
- Wrong chain, RPC errors, malformed/mismatched batch responses, timeout and cancellation.
- Same block for all reads; failure of one account never produces a complete snapshot.
- Unverified/missing/corrupt wallet fails without generating replacement storage.

Application tests:

- iOS release-mode bridge invokes the registered method; missing method still fails clearly.
- Wallet/funding-address mismatch and inconsistent totals are rejected.
- Home initial load and Refresh show total/funding/receiving values using the real
  provider and mocked native boundary. Cover retry, zero balances, retained previous
  data after failure, logout/session replacement and stale completion.
- Reuse `tests/functional/wallet/mainnet.functional.test.tsx` and
  `sourceUsdc.functional.test.tsx`; avoid duplicating whole screen suites.

Run mobile typecheck, affected lint/format checks, relevant Jest suites, Swift tests
in Debug and Release, and an iOS simulator build. Run existing Android regression
checks if shared contracts or behavior change. Record mocked tests separately from
live RPC checks and physical-device acceptance.

Update `docs/PARITY.md` and the native signer documentation with supported public
portfolio reads and limits. Simulator verification must not add an authentication
bypass. Physical iPhone acceptance: open a verified wallet, compare against live
on-chain balances, refresh after a known balance change and verify lock/cancellation.

## Suggested commits

1. `refactor(wallet): share Monad portfolio rules in Rust` — account fixtures,
   exact arithmetic, bindings and Android migration with regression tests.
2. `feat(ios): connect shared mainnet portfolio to Home` — read-only transport,
   registration, native/bridge/provider tests and lifecycle integration.
3. `docs(wallet): record GIZU-1 portfolio parity and verification` — readiness evidence,
   limitations and outstanding device checks.

## Completion boundary

Code completion requires passing native/application checks and a verified simulator
build. User acceptance requires seeing the total and breakdown update on a real
supported iOS installation. Neither a mocked Home test nor successful compilation
proves physical-device portfolio access. No commit, build upload or deployment was
requested for this implementation.

## Implementation outcome and verification

- Shared implementation: `core/src/portfolio.rs`; generated Swift/Kotlin bindings
  and ARM64 Android / iPhone / Apple Silicon simulator libraries rebuilt.
- Android public reader now uses shared selection, batched derivation, strict ABI
  decoding and checked totals. Its encrypted incremental cache, partial/stale
  states, history and additional owned-asset reader remain intact.
- iOS registers the existing `getMainnetPortfolio` method, uses the same Rust
  financial rules and returns complete public USDC observations. Existing Home
  initial, foreground and manual refresh paths need no new UI.
- Home provider ownership now resets on wallet/funding-address replacement and
  ignores late completions, including effect teardown/restart.
- Account-0 decision: preserve Android wire semantics. Both rows 0 and 1 retain
  role `funding`; only index 1 contributes to `fundingAtoms`. Account 0 contributes
  to `returnAtoms`. No product relabeling or wallet migration is included.

Verified locally on 2026-10-02:

| Check                                   | Result                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Rust core suite                         | 144 tests passed                                                                                                                   |
| Kotlin Debug and Release unit tests     | 224 tests passed in each configuration; real host Rust bindings exercised                                                          |
| Swift Debug and Release simulator tests | 29 tests passed in each configuration; real simulator Rust bindings exercised                                                      |
| Shared financial fixtures               | Rust, Kotlin, Swift and Home validator agree on complete, partial and stale observations                                           |
| Maximum supported registry              | 8191 derived public accounts; bounded four-by-40 RPC batches with injected transport; no partial result published                  |
| Mobile JavaScript coverage suite        | 74 suites / 609 tests passed; configured coverage thresholds passed                                                                |
| TypeScript, ESLint, Prettier            | Passed                                                                                                                             |
| iOS simulator app build                 | Debug ARM64 build passed, including Expo registration; retained signer excluded from Pods/registration                             |
| Live read-only RPC smoke                | Chain 143, finalized block, two public deterministic fixture addresses, 32-byte USDC ABI results and canonical hash recheck passed |

Additional strict Clippy check (`cargo clippy --locked --lib -- -D warnings`):
blocked by two existing `too_many_arguments` findings in
`earn_ethereum_liquidity.rs:124` and `earn_sponsored.rs:178`. The new portfolio
module has no remaining Clippy findings. These unrelated Earn APIs were not changed.

The live check used public test addresses, not a user's wallet or signing request.
Maximum-registry transport tests use mocked responses and do not prove public RPC
throughput under real rate limits. The iOS reader remains all-or-error within the
existing 120-second ceremony deadline. Swift unit tests cover cancellation, malformed
responses, wrong chain, reorg, timeout propagation and absent/corrupt/unverified storage.
Android tests cover strict ABI rejection and incremental cache recovery as well as
existing portfolio regressions.

The local simulator command must target `ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`:
the generated signer supports Apple Silicon simulators, not Intel simulators. An
initial generic build requested both architectures and failed; the ARM64 rebuild
passed. Release CI already uses the correct flags.

Remaining acceptance: open a backup-verified wallet on a physical iPhone, compare
Home totals with its on-chain public accounts, refresh after a balance change, and
verify background/lock cancellation. Android device smoke after rebuilding is also
pending. No claims of iOS Earn/holdings/history parity are added by GIZU-1.
