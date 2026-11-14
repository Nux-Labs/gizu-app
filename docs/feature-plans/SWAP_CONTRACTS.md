# Swap contracts and provider boundaries

**Complexity:** 3. **Status:** implemented reference. **Source review:** 2026-11-14.
Start with [Swap architecture](SWAP_ARCHITECTURE.md). This describes repository
contracts, not a promise about current upstream API availability.

## React Native → native

The [stored signer contract](../../mobile/src/domain/wallet/storedSigner.ts) and
[capability-checked bridge](../../mobile/src/services/wallet/nativeBridge.ts) expose
intent operations: deposit/status/holdings reads, start, sell, payout/recovery,
resume and cancel. Inspect the contract for exact method signatures.

Amounts cross boundaries as integer decimal strings in base units, not floating
point currency. Token contract identity and network matter; a symbol is insufficient.
Native code derives accounts from its wallet/registry rather than accepting arbitrary
JavaScript-selected private-key paths.

Public views expose operation ID, phase, step, pause code, amounts and counters.
Platform wrappers add public address metadata. Optional fields and aggregation can
differ between wrappers; core public JSON alone is not the full app bridge contract.
The UI's parser must not be treated as evidence that every native field is present.

Current sells expose `completionTarget: "confidential"`, `privateCreditedAtoms`,
`holders`, zero `legs` and no return addresses. `sellSwapHolding(token + ":all", gateway)`
selects the full eligible owned holder set natively; legacy batch IDs and persisted
public-return operations retain their older completion contract. Tracked contracts,
account ownership and excluded Earn indices are checked by shared Rust, not supplied
as signing paths from JavaScript.

JavaScript supplies a gateway URL in this implementation. The Rust gateway parser
permits HTTPS and specific local-development HTTP forms, with shape restrictions;
platform transport adds its own checks. Do not describe the swap gateway as universally
hard-pinned or confuse it with Earn's separate backend configuration.

## Native → Rust → native

`SwapOperation.start` accepts a bounded JSON plan, native entropy, gateway and time.
It checks operation kind, source/recipient/holder indices and amount representation.
`restore` imports versioned state without restoring seed material.

| Core output                         | Native responsibility                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `Request { id, method, url, body }` | Persist, execute approved transport, return the matching ID/status/body, persist result |
| `Wait { millis }`                   | Persist and wait cancellably; do not busy-loop                                          |
| `Review { text }`                   | Display native terms and obtain required authorization before approval                  |
| `Unlock`                            | Obtain fresh passkey authorization for the same wallet/plan                             |
| `Paused { code }`                   | Preserve state and expose the stop without silently restarting                          |
| `Finished`                          | Persist and expose completion; update the independent public summary                    |

The core owns quote validation and signatures. Native orchestration owns scheduling,
transport and durability. Neither an HTTP 200 nor provider JSON bypasses core checks.

## Backend gateway map

All paths below are under `/v1/swap`. Schemas are defined in
[swap.routes.ts](../../backend/src/http/routes/swap.routes.ts).

| Routes                                                            | Adapter / provider              | Responsibility                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /aurora/tokens`                                              | Aurora                          | Normalize supported assets; adapter has a temporary token cache                                                               |
| `POST /aurora/quote`                                              | Aurora                          | Exact-input route quote for origin/confidential/destination legs                                                              |
| `POST /aurora/generate-intent`                                    | Aurora                          | Obtain a payout intent to validate and sign natively                                                                          |
| `POST /aurora/submit-intent`                                      | Aurora                          | Relay already-signed ERC-191 intent data                                                                                      |
| `POST /aurora/status`                                             | Aurora                          | Route status using deposit address and optional memo                                                                          |
| `GET /aurora/auth-salt`                                           | NEAR RPC through Aurora adapter | Read the authentication salt                                                                                                  |
| `POST /aurora/authenticate`, `/aurora/balances`                   | Aurora                          | Exchange signed authentication for access, then read private balance                                                          |
| `POST /aurora/history`                                            | Aurora                          | Authenticated operation history for a deposit address; absent adapter support returns 503 `AUTHENTICATED_HISTORY_UNAVAILABLE` |
| `POST /monad/prepare-funding`                                     | Pimlico / Monad RPC             | Build unsigned sponsored funding UserOperation and optional EIP-7702 authorization                                            |
| `POST /monad/submit`, `/monad/receipt`                            | Pimlico                         | Submit signed UserOperation and inspect its receipt                                                                           |
| `POST /fusion/preview`, `/fusion/permit-context`, `/fusion/order` | 1inch / Robinhood RPC           | Liquidity/output preview, permit data and unsigned order construction                                                         |
| `POST /fusion/submit`, `/fusion/status`                           | 1inch relayer                   | Relay signed order; read fills/status. Accepted is not filled.                                                                |

Gateway schemas reject malformed shapes; native policy validates the financial
meaning. Provider API keys stay in backend configuration. Signed payloads and
private-balance access tokens pass through the backend as required for relay; the
backend is not blind to them, even though it does not own wallet private keys.

## Funding checks

The [Pimlico adapter](../../backend/src/adapters/pimlico/monad-funding.ts) uses a
watch-only owner. It prepares a Monad USDC transfer with sponsored gas and a fee
cap; native [funding policy](../../mobile/modules/gizu-stored-signer/core/src/swap/funding.rs)
checks the operation against source, recipient, amount, budget and chain state
before signing. Where required, EIP-7702 delegation authorization is also signed
natively. A funding receipt and Aurora credit are separate observations.

## Aurora checks

The [adapter](../../backend/src/adapters/aurora/aurora-intents.ts) reaches Aurora
and NEAR; [native quote/intent validation](../../mobile/modules/gizu-stored-signer/core/src/swap/aurora.rs)
binds requests to expected assets, amounts, recipients and route terms.
The route's confidential spending identity and its authentication context are
related but not interchangeable. An authenticated aggregate balance is not an
individual payout receipt. Current private-completion sells require authenticated
history matching the sale's deposit address, route identities, amount, time bounds
and verified Fusion transaction hashes. A pre-approval history probe fails closed
before stock orders if that service is unavailable. Sale credit is recorded only
from matching operation history; it never uses the funded-buy 401 fallback.
See the failure guide for funded-buy fallback, payout-only balance authentication
and private-sale credit failures.

## Fusion checks

The [1inch adapter](../../backend/src/adapters/oneinch/fusion.ts) targets Robinhood,
returns preview/permit/order material, and exposes relayer fills. The
[native validator](../../mobile/modules/gizu-stored-signer/core/src/swap/fusion.rs)
checks binding, minimum output, traits, expiry, salt, extension, receiver and hash.
Core reconciliation compares fill receipts and transfer logs with expected balance
changes. Relayer acceptance or token listing does not imply execution or liquidity.

## Failure translation

Status 0, 429 and 5xx are transient at the core transport boundary. Rejected quote
HTTP responses become `QUOTE_REJECTED` at specific steps; locally invalid data
can become `REJECTED_<step>`. Keep phase, step and HTTP evidence together before
assigning fault to a provider. See [the complete failure guide](../internal/SWAP_FAILURES.md).
