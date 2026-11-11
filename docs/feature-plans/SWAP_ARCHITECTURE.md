# Swap architecture

**Complexity:** 3 — Detailed. **Status:** implemented architecture reference, not a new proposal.
**Reviewed:** 2026-10-08 against local source; no live provider or funded-device verification.
**Ownership:** component responsibilities below; individual maintainer assignment is not recorded.

## Purpose and scope

Explain who can propose, approve, sign, submit, persist and recover a Gizu swap.
This is the starting point for technical changes to the existing confidential swap.

Read alongside:

- [Contracts and provider boundaries](SWAP_CONTRACTS.md): bridge, core and gateway interfaces.
- [Persistence and recovery](SWAP_PERSISTENCE.md): durable state, crash boundaries and platform differences.
- [Aurora flow](AURORA_SWAP_FLOW.md): buy/sell illustrations and privacy explanation.
- [Failure guide](../internal/SWAP_FAILURES.md): phases, pause codes and investigation actions.

This describes the stored-wallet swap implementation, not Earn's independent
execution pipeline or the retired signer. Catalog browsing across multiple networks
does not expand executable swap support: the inspected UI gates selections to
chain 4663, `swapListed` and `buyable`, and native/provider policy is separately enforced.
A new buy (`confidentialSwap`, `confidentialPayout`) may only target one of the 25
Robinhood stocks in [`shared/swap-targets-v1.json`](../../shared/swap-targets-v1.json),
ranked by 1inch price impact at 25,000, 5,000 and 1,000 USDG. The Rust engine
(`pins.rs`), the backend catalog (`swap-targets.ts`) and that file must list the same
addresses; tests in both languages compare them. Sell and recovery are not limited, so a
holding stays sellable after its token leaves the list. The per-order liquidity check in
Fusion preview still runs for every buy.
The current execution path uses Monad USDC, confidential credit and Robinhood USDG
as the intermediate asset for a Fusion token trade.

## Ownership and authority

| Layer                         | Owns                                                                                                                             | Does not own                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| React Native                  | Token selection, amount input, public status, navigation, user intent and bridge invocation                                      | Keys, signature bytes, native approval or authoritative settlement                |
| Swift / Kotlin                | Wallet access, native review/passkey flow, platform lifecycle, transport, durable storage and driving core requests              | Permission to substitute an unchecked transaction for the reviewed core operation |
| Shared Rust core              | Plan validation, derivation, request sequence, quote/order constraints, signatures, state transitions and public status          | HTTP execution, platform file I/O, passkey UI or independently verified consensus |
| Gizu backend                  | Validate gateway request shape, hold provider API keys, prepare unsigned funding/orders, relay signed requests and expose status | Wallet private keys or authority to approve a swap                                |
| Aurora / confidential Intents | Asset registry, route quotes, deposit/payout processing, private-balance authentication and route status                         | Native user approval or proof that a subsequent Fusion trade completed            |
| Pimlico                       | Funding preparation, ERC-20 paymaster/bundler services and UserOperation submission/receipt                                      | App wallet signing; gas sponsorship is not a free-funds guarantee                 |
| 1inch Fusion                  | Executable previews, permit context, order construction, relayer status and resolver execution                                   | The app's local minimum-output, receiver and order-binding approval policy        |
| Chain RPC                     | Chain identity, balances, nonces, receipts and transfer logs used in checks                                                      | Native authorization; RPC responses are observations, not light-client proofs     |

The backend's funding owner is explicitly watch-only: signing methods throw.
A malicious or malformed service response must still pass native validation.
Native code remains inside the signed-app trust boundary; this is not protection
against a malicious native update, compromised device or all provider collusion.

## Control flow

1. React Native validates an entered amount for representation and sends user intent
   through the capability-checked bridge. UI validation is not spending authority.
2. Native code opens the wallet, selects/reserves eligible accounts and persists
   recipient allocation before creating the core operation.
3. Rust produces one next action: request, wait, review, unlock, pause or finish.
4. Native code persists state before issuing a request. It supplies the response
   with its request ID; Rust validates it and chooses the next transition.
5. At review/unlock boundaries the native screen obtains the required passkey
   authorization. A JavaScript callback cannot approve a core operation.
6. Signed payloads remain native and travel through the backend to providers.
   Receipts, route credit, fills and balances drive subsequent checks.
7. React Native receives a public view. A returned native call can mean paused or
   awaiting action; it does not necessarily mean the swap completed.

This is a persisted state machine, not one atomic cross-chain transaction. Funding,
payouts and token trades can complete independently and leave recoverable residuals.

## Operation variants

| Variant                | Starting funds                              | Main path                                                                      |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `confidentialSwap`     | Selected public Monad USDC source           | Sponsored funding → confidential credit → recipient payouts → Fusion buys      |
| `confidentialPayout`   | Existing authenticated confidential balance | Read available private balance → payouts → Fusion buys; no new Monad deposit   |
| `confidentialSell`     | Selected allocated token-holder batch       | Fusion sale into Aurora deposit → confidential credit → fresh Monad recipients |
| `confidentialRecovery` | USDG left in allocated recipient accounts   | Bounded recipient scan → finish token purchases using those balances           |

The recovery variant is not generic cross-chain asset recovery. Sell holder and
return-recipient indices are distinct, validated sets. An available token in the
catalog is neither a route quote nor proof of Fusion liquidity.

## Wallet count and payout shares

A buy no longer always spreads over three wallets with a 30/30/40 split. Native code draws
random bytes once before review and `choose_buy_legs` (Rust, `swap/legs.rs`) turns them into a
plan that is shown in the review and persisted with the operation, so a restore or retry never
rolls it again.

| Budget (USDC)  | Wallets drawn from |
| -------------- | ------------------ |
| under 5        | 1                  |
| 5 up to 20     | 2                  |
| up to 100      | 2 or 3             |
| up to 1,000    | 3 or 4             |
| above 1,000    | 4 or 5             |

Upper bounds are inclusive. A budget under 5 USDC stays in one wallet because Aurora rejects a
deposit under 0.075 USDG and one rejected leg stops the whole operation. Each share is 70%–130% of an equal share, so two wallets get
35%–65%. Shares are whole basis points and always add up exactly. The engine accepts one to
five wallets and rejects plans outside that or with invalid weights.

A sell follows the same rule. Native code reserves up to five fresh return wallets and puts
random bytes (`legsRandom`) in the plan. Once the sale is priced, the engine draws the payout
count from the estimated proceeds with the table above and the shares with the same band, and
drops the reserved wallets it does not need; the review shows the result. Every holder is sold
and credited to C first, then C's pooled balance is split over the payouts, so no sale can be
matched to one payout. Native code never sends weights for a sell. A sell saved before this
change has no `legsRandom` and finishes the older way: each return wallet receives the proceeds
of the holder in the same position.
A buy from existing private balance has no budget to size from and keeps three wallets.

Allocation reserves whole blocks of three indices and uses the first `count` of them, so every
swap starts on a block boundary. Holdings are grouped and sold in blocks of three; this keeps
one swap's wallets from sharing a sell group with another swap's. A swap of four or five
wallets therefore sells in two groups, and unused indices in a block are never funded. Sell
reviews list only wallets that hold the token.

## Shared engine versus platform orchestration

Both platforms consume the same `SwapOperation` through generated UniFFI bindings.
Those bindings are private native plumbing, not a JavaScript signing API.

Android additionally uses `NativeFundingPlanner`, `FundingReservations`,
`SwapFundingBatch` and an in-memory `SwapBatchApproval`. A user budget may span
multiple source accounts, with child core operations and a combined review.
The batch can contain completed sources while another child remains unfinished.

The inspected iOS `StoredSwapEngine` drives a single core operation and a smaller
active-state envelope. Do not infer Android batch persistence, funding selection
or combined-approval parity merely because the Rust engine is shared.

Read queues in the JavaScript bridge reduce overlapping native reads. They are not
a financial transaction lock or a replacement for native reservations, lifecycle
checks and operation ownership. See [persistence](SWAP_PERSISTENCE.md).

## Privacy and observability boundaries

Public-chain funding and destination transfers remain visible. Confidential credit
is the private middle segment; providers and the gateway can still observe parts
of the route and correlate timing or amounts. This architecture does not guarantee
unlinkability.

Backend routes use POST bodies for address-bearing status requests to avoid wallet
links in ordinary URL logs. That does not hide the request from the gateway/provider.
Diagnostics should contain route, stage, classified status and timing—not bodies,
provider keys, access tokens or exported state. See [failure diagnostics](../internal/SWAP_FAILURES.md).

## Change and acceptance requirements

Changes to routes or assets must update native pins/validation, gateway adapters,
UI eligibility and recovery together. Enabling a catalog option alone is insufficient.
Changes to persisted state need versioning and migration/restore tests; changes to
approval must preserve exact plan/amount/receiver binding and expiry behavior.

Before claiming a change works, distinguish:

- Rust/state-machine and provider-response fixture tests.
- Swift/Kotlin storage, lifecycle and transport tests.
- React Native public-contract and interaction tests.
- Real device passkey/foreground/cancellation checks.
- Quote-only provider probes versus funded settlement and residual recovery.

No architecture document or mocked test establishes present provider availability.

## Implementation entry points

- [React Native hook](../../mobile/src/features/swap/useNativeSwap.ts), [UI adapter](../../mobile/src/features/swap/confidentialSwap.ts), [bridge](../../mobile/src/services/wallet/nativeBridge.ts).
- [Rust engine](../../mobile/modules/gizu-stored-signer/core/src/swap/engine.rs) and [pins](../../mobile/modules/gizu-stored-signer/core/src/swap/pins.rs).
- [Android engine](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/swap/SwapEngine.kt) and [iOS engine](../../mobile/modules/gizu-stored-signer/ios/Swap/SwapEngine.swift).
- [Backend routes](../../backend/src/http/routes/swap.routes.ts).
