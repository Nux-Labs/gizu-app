# Swap architecture

**Complexity:** 3 — Detailed. **Status:** implemented architecture reference, not a new proposal.
**Reviewed:** 2026-11-14 against local source; no live provider or funded-device verification.
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
Robinhood stocks in the `4663` list of [`shared/swap-targets-v2.json`](../../shared/swap-targets-v2.json),
ranked by 1inch price impact at 25,000, 5,000 and 1,000 USDG. The Rust engine
(`pins.rs`), the backend catalog (`swap-targets.ts`) and that list must hold the same
addresses; tests in both languages compare them. The file also holds a measured `8453`
(Base, Coinbase-issued, USDC) list; regenerate a chain's list with
`npm --prefix backend run swap:measure -- --chain <id> [--write]`. Sell and recovery are not limited, so a
holding stays sellable after its token leaves the list. The per-order liquidity check in
Fusion preview still runs for every buy.
The current execution path uses Monad USDC, confidential credit and Robinhood USDG
as the intermediate asset for a Fusion token trade.

A plan may name its target chain with `chainId`; a plan without one is Robinhood (4663).
The engine resolves it to a pinned `TargetChain` (`pins.rs`) on start and on restore, and
refuses any other chain. That record fixes the target RPC, the Aurora payout asset, the
stablecoin, the permit and order EIP-712 domains, the LOP spender and the Fusion settlement
contract, and the chain's own buy list. Base (8453) pays out USDC through Aurora's `base`
asset and uses the canonical LOP v4 (`0x1111…0A65`) with settlement `0x2Ad5…1Ef5`. Robinhood
gateway bodies stay byte-identical because the deployed gateway rejects unknown fields; a Base
body adds `chainId` and, for a buy, the USDC source.

The gateway's `/v1/swap/fusion/*` bodies take that optional `chainId` (4663 or 8453; absent
means Robinhood) and route to one Fusion adapter per chain. The Base adapter uses Fusion network
8453, Base USDC as the buy-side stablecoin and liquidity reference, and `BASE_RPC_URL` (default
`https://mainnet.base.org`) for permit reads. `/v1/tokens?chainId=8453` lists Base with Coinbase
stock tokens marked `issuer: "Coinbase"`; only the pinned list is `buyable`, and a token Coinbase
has paused is not. A list without `chainId` still returns 4663, 143 and 1 only, so older clients
never see Base. `/v1/tokens/8453/:address/details` serves Coinbase's record (no trading
sessions, `sessions: null`) with a 1inch price and USD candles directly from GeckoTerminal.
Base issuer, price and chart enrichment share a two-second deadline; expired optional fields
remain unavailable while the page retains its pinned identity. Pool discovery and charts reuse
their caches and coalesce concurrent requests. When Coinbase is unreachable the catalog still
marks the pinned list and the page falls back to the pinned symbol.
There is no server-side switch: Base buys run as soon as a client sends a Base plan.

The detail screen shows the selected catalog metadata and selection action immediately, with
loading and retry confined to the history area. Known issuer facts enrich that view when they
arrive, and the previous chart remains visible while another period loads.

In the app, the swap picker asks `/v1/tokens?chainIds=4663,8453&liquidOnly=true`, so Robinhood
and Base stocks share one list (Robinhood first); a stock on both chains appears once per chain,
Robinhood rows with the Robinhood Chain mark and Base rows with a "Base" badge. The buy controller
reads the chosen token's chain from its list entry (stock addresses are unique across chains) and
passes it to the estimate (`chainId` and Base USDC as `srcToken`) and to `startSwap`/`startPayout`.
Detail pages load `/v1/tokens/:chainId/:address/details`; a Base page names Base as the price
venue and shows "Onchain, any time" for trading. The sell estimate prices a holding into its own
chain's stablecoin, the Home "Sell" shortcut covers both chains, and the asset sweep runs on 4663
and 8453.

The native bridge takes the chain as an optional trailing `chainId` on `startSwap`,
`startPayout`, `startRecovery` and `getSwapHoldings`; JS omits it for Robinhood so a bundle and
a native build from either side of the change agree on arity. Both shells keep the swap ledger per
chain (iOS moves its version 1 file to version 2, Robinhood), read holdings on every tracked chain
and report each holding's `chainId`. A sell resolves its chain from the ledger entry of the
holding's token, so holding IDs stay `token:index`. Android's owned portfolio reads Base at
`latest`, pinned by block hash, like Robinhood, and wallet restore scans Base USDC as well as
Robinhood USDG for used recipients.

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

| Variant                | Starting funds                                 | Main path                                                                                                                         |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `confidentialSwap`     | Selected public Monad USDC source              | Sponsored funding → confidential credit → recipient payouts → Fusion buys                                                         |
| `confidentialPayout`   | Existing authenticated confidential balance    | Read available private balance → payouts → Fusion buys; no new Monad deposit                                                      |
| `confidentialSell`     | All eligible owned holders of a selected token | Fusion sale into Aurora deposit → operation-bound verified confidential USDC credit; legacy saved plans can retain public payouts |
| `confidentialRecovery` | USDG left in allocated recipient accounts      | Bounded recipient scan → finish token purchases using those balances                                                              |

The recovery variant is not generic cross-chain asset recovery. Sell holder and
return-recipient indices are distinct, validated sets. An available token in the
catalog is neither a route quote nor proof of Fusion liquidity.

## Wallet count and payout shares

A buy no longer always spreads over three wallets with a 30/30/40 split. Native code draws
random bytes once before review and `choose_buy_legs` (Rust, `swap/legs.rs`) turns them into a
plan that is shown in the review and persisted with the operation, so a restore or retry never
rolls it again.

| Budget (USDC) | Wallets drawn from |
| ------------- | ------------------ |
| under 5       | 1                  |
| 5 up to 20    | 2                  |
| up to 100     | 2 or 3             |
| up to 1,000   | 3 or 4             |
| above 1,000   | 4 or 5             |

Upper bounds are inclusive. A budget under 5 USDC stays in one wallet because Aurora rejects a
deposit under 0.075 USDG and one rejected leg stops the whole operation. Each share is 70%–130% of an equal share, so two wallets get
35%–65%. Shares are whole basis points and always add up exactly. The engine accepts one to
five wallets and rejects plans outside that or with invalid weights.

Current full-holding sells do not use the payout ladder. The app submits `token:all`;
Rust selects all eligible allocated holders, including partial groups, excluding Earn
recipients. After fresh balance reads the plan freezes the funded holders and native
review lists the real sales. There can be up to 8,189 eligible indices (3–8191),
subject to the wallet registry. The sale has `completionTarget: "confidential"`,
no new public recipients, no random payout weights and zero payout legs. After
approval the core reads C's authenticated private balance before any sale; sales run
one at a time, and each is credited with the balance growth over the previous reading,
bounded below by its quote minimum (scaled to the deposit) and above by the stablecoin
it deposited (Earn's `balance-delta-v1` method; Aurora's operation history is
invite-only). Growth outside that range pauses the sale rather than attributing other
private cash to it; public route SUCCESS alone is insufficient.
The resulting `privateCreditedAtoms` remains in confidential Account 2 until a separate,
capability-checked [public withdrawal](../internal/CONFIDENTIAL_WITHDRAWALS.md).

Legacy persisted public-return sells keep their saved plans. Randomized public-return
plans pool credit and use the amount ladder above; older plans without `legsRandom`
retain the positional holder/return relationship. iOS also retains the explicit
three-holder bridge path for these public-return terms. The normal sell form always
requests `:all`. Status/history `completionTarget` separates the completion contracts.

Buy allocation reserves whole blocks of three indices and uses the requested count,
so unused indices stay unfunded. Legacy three-holder batch IDs remain readable;
they do not limit the current full-holding sell or require sequential user sales.
A buy from existing private balance currently retains three recipients. A public-funded
buy authorizes its guaranteed route credit only, leaving pre-existing private cash alone.

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
