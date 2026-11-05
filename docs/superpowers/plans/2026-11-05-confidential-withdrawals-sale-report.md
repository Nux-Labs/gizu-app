# Task 2: confidential sale completion

Implemented only the swap core, Android swap engine/history adapter and focused
swap tests. No UI, backend, native module, generated bindings, device or funded
transaction changes were made by this task.

## Behavior and evidence

New Android sale plans explicitly persist `completionTarget: "confidential"` and
use their existing holder indices as internal non-payout slots. They allocate no
public receiving accounts and draw no new recipient randomness. Missing policy
retains the existing public sale behavior and saved legacy operations remain
restorable.

Before financial review or any Fusion permit/order signature, a new sale performs
read-only confidential authentication and probes the bounded authenticated history
endpoint. Missing or unavailable endpoints pause before selling. Every actual
inbound deposit is then saved with its route, canonical receipt transaction hash
set, actual USDG input and quote time. A partial fill retains its earlier deposit
and verified credit across restart before another route is created.

Completion requires authenticated SUCCESS history for each exact inbound deposit:
private C recipient, origin/destination assets, refund owner, deposit mode, no memo,
actual input, minimum private output, unique verified transaction hashes, and
creation time within the quoted operation. Resolver transaction senders may differ
from the holder; ownership is established by the verified maker/deposit transfer
logs. Duplicate, foreign, malformed and stale history is rejected. Missing credit
keeps the operation pending. Authentication failure never falls back to a route
minimum or aggregate C balance for the new policy. Refunds pause with explicit
`SALE_CREDIT_REFUNDED` / `SALE_CREDIT_FAILED` recovery codes.

Public status exposes `completionTarget`, `privateCreditedAtoms`, target-token
`soldAtoms`, and `receivedUsdgAtoms`. Private sales have zero public payouts,
`legs: 0`, their actual holder count and no return addresses. Completed private
history uses verified private credit as `receivedAtoms`; legacy history keeps its
existing amount meaning. Cancellation history is retained. A new private sale can
only become CANCELLED before saved permits/orders/inbounds; signed or credited
work instead pauses with its journal intact, and cancelling COMPLETE preserves
completion. Thus valid new confidential CANCELLED history has zero private credit.

Android execution admission calls the shared cashout exclusion guard, additionally
binding the verified wallet identity. Restore/view stays read-only. Changed private
credit invalidates the corresponding cached confidential balance observation once
per credited amount; cache values are never fabricated from operation credit.

## Verification

Observed RED for the missing new-sale policy/terminal behavior; implemented GREEN.
Observed RED for a missing preflight history capability; implemented GREEN.
Observed RED for cancellation discarding signed sale progress; implemented GREEN.
Additional regressions cover preexisting private cash, fourteen malformed/foreign
history cases, missing credit/restart, 401 recovery, refunds, policy/receiver
validation, sub-USDC exact amounts, partial fills/restart and unchanged plan data.

Commands (repository root):

```sh
/Users/ouyildiz/.cargo/bin/cargo test --locked --manifest-path mobile/modules/gizu-stored-signer/core/Cargo.toml
/Users/ouyildiz/.cargo/bin/rustfmt --check --edition 2024 mobile/modules/gizu-stored-signer/core/src/swap/engine.rs mobile/modules/gizu-stored-signer/core/src/swap/engine_tests.rs
ANDROID_HOME=/Users/ouyildiz/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home mobile/android/gradlew -p mobile/android :gizu-stored-signer:testDebugUnitTest --tests 'io.gizu.storedwallet.swap.SwapSalePolicyTest' --tests 'io.gizu.storedwallet.swap.SwapHoldingsTest' --tests 'io.gizu.storedwallet.swap.SwapBatchApprovalTest' --tests 'io.gizu.storedwallet.swap.SwapFundingBatchTest'
```

Full Rust tests passed: 219 tests, zero failures; doc tests also passed.
The four scoped Kotlin classes passed 16 tests, including the two new sale-plan
and history-policy tests. The shared cashout guard's persistence/competition tests
are owned by Task 1; final integrated native verification remains with the parent.
Only affected Rust files were formatted with rustfmt and affected Kotlin files
with the pinned ktfmt 0.54 formatter. No crate-wide formatting was run.

The authenticated history endpoint is not assumed to exist on the current hosted
backend. This task did not deploy it; the early capability probe prevents a new
sale from moving funds when that endpoint is unavailable. Tests use deterministic
provider/chain fixtures and native unit tests, not live transactions.

## Follow-up: invalidate origin observations before private-credit refresh

Confirmed that `TokenBalanceSync.readAvailable` could reuse a complete observation
inside its 30-second window after a sale had credited private USDC. The aggregate
owned-asset summary could therefore still describe the sold token as fresh.

Added reusable `NativeOwnedPortfolio.invalidateTokens(record, chain, tokens)`;
`native` is an optional sentinel alongside ERC-20 addresses. It marks only the
selected token summaries/shards and origin native observations stale, retaining
observed balances. `TokenBalanceSync.invalidate()` adds cached owners to its
bounded pending reads and prevents the freshness fast path until canonical reads
finish. Large groups retain their existing 80-owner read limit and continuation.
Unrelated token caches remain fresh. Swap invokes origin invalidation when verified
sold/private-credited amounts change, before saving the newly credited state.
The native Earn worker also uses this API for origin stable/vault/native groups.

Observed all three tests RED against no-op invalidation, then GREEN:

```sh
ANDROID_HOME=/Users/ouyildiz/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home mobile/android/gradlew -p mobile/android :gizu-stored-signer:testDebugUnitTest --tests 'io.gizu.storedwallet.SalePortfolioInvalidationTest'
```

Three tests passed: stale retained sold-token observations on provider failure and
canonical refresh within the old TTL; 81-owner bounded continuation; stable/native
origin invalidation. Kotlin compilation passed. Final full native verification is
owned by the parent. The helper addresses owned-token/native caches; the separate
headline public Monad-USDC cache is outside this helper's scope.
