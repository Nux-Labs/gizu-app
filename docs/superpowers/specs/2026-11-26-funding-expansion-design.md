# Base and Arbitrum funding expansion: proposed design

Status: proposed for review; implementation has not started.

Feasibility follow-up: [live checks, existing mechanisms and remaining gaps](../feasibility/2026-11-26-funding-expansion.md). Exact Base/Arbitrum canonical-private routes returned successful unfunded quotes. Reuse existing source-credit envelopes and journals; no new funding-credit table or standalone pool object is required by the baseline design.

Branch: `feat/funding-expansion`, created from `origin/main` at
`23a82ec77bf568b277b01f8d004497798cafcd40` (includes PRs #80–#83).

## Product contract

- Add Base and Arbitrum One alongside Monad as funding networks.
- Use the existing Account 1, `m/44'/60'/0'/0/1`, on every funding network.
  These are three network contexts for the same EVM address, not three newly
  derived wallets. Keep Account 2 as the shared confidential identity.
- Show the network during funding only: receiving funds, funding review,
  funding approval and funding recovery. Elsewhere show combined USDC balances
  and one Swap or Earn journey. Keep chain/token identity internally.
- Combine sources when one source cannot cover the requested budget. A wallet
  with 10 USDC on Monad and 10 on Base can request a 15 USDC budget.
- Preserve the current amount convention, explicitly confirmed by the user:
  **15 USDC is the total budget, including fees.** Source gas, routing and
  execution reserves stay inside that budget. Keep the existing fee review and
  minimum-result behavior; do not add fees on top or introduce a net-target mode.
- Support funding and Swap on Android and iOS. Preserve current iOS Earn
  availability, as explicitly selected by the user; full guided Earn parity is
  outside this change. Expand Android's existing guided Earn journey.
- Reuse the native signer, Pimlico funding, Aurora routes, private payouts,
  approval grants, encrypted journals, reservations and distribution machinery.
  Do not add another wallet SDK, signing provider or cross-chain bridge.
- The functional change ends at funding the shared private USDC balance. Feed
  the approved combined amount into the existing private-funded Earn or Swap
  path. Preserve its recipient distribution, execution and fee rules.
- Preserve the existing return policy: sales and investment exits return to
  private USDC. Making funds public remains the separate, explicitly requested
  **Withdraw from Gizu** action. No automatic public withdrawal is added.

In code, "payout" also names an internal transfer from private USDC to a saved
investment/trading wallet. It does not necessarily mean withdrawal from Gizu.
This expansion does not redesign that downstream transfer machinery.

## Proposed flow

1. Observe supported public USDC sources and the existing private USDC balance.
   Display one total, retaining completeness and stale-read information.
2. At action time, refresh spendable balances and reservations natively. Use
   available private USDC first, then prefer one sufficient public source. Split
   only when needed; reject uneconomic fragments using real fee/minimum bounds.
3. Prepare one immutable review containing the selected sources, gross budgets,
   maximum fees, minimum credits, intended action and saved recipient weights.
   Reserve all selected amounts before any submission.
4. For each public source, obtain an Aurora quote from that network's USDC into
   the **same canonical confidential USDC asset** at Account 2. Save its quote,
   private baseline, refund address and operation identity before signing.
5. Use the existing Pimlico EIP-7702/EntryPoint 0.8 funding path to transfer from
   Account 1 to that route's deposit address. Pay gas in source-chain USDC.
   Each selected network needs its own UserOperation signature; first use may
   also need that network's EIP-7702 authorization. Reuse bounded native approval
   grants; extra cryptographic signatures need not mean a separate biometric
   prompt for each one.
6. Reconcile that source's receipt, route outcome and authenticated bounded
   private-balance increase. Save its credited amount durably before submitting
   the next incoming funding leg to Account 2.
7. Once all selected credits are confirmed, authorize spending only the approved
   existing private amount plus those credits, less prior allocations. Pass
   that approved amount to the existing private-funded Earn or Swap journey.
   Keep its saved recipient distribution and normal execution unchanged; the
   downstream journey consumes one private balance, not separate public-chain
   funding sources.
8. On interruption, resume the same parent and child operations. A completed
   source is never deposited again. A failed later source leaves earlier funds
   in private USDC, reserved for the pending journey until reconciliation or
   safe cancellation releases them.

The combination happens in Aurora's private ledger, **not** by sending all
public USDC to Monad first. Balance reads and preparatory quotes may run in
parallel. Source deposit submission and attribution are ordered because the
current integration does not use `/history`.

## Asset and provider boundaries

| Source       | Chain ID | Exact public USDC contract                   | Aurora origin asset                                                |
| ------------ | -------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Monad        | 143      | `0x754704bc059f8c67012fed69bc8a327a5aafb603` | `nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`         |
| Base         | 8453     | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| Arbitrum One | 42161    | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near`  |

All three public tokens use six decimals. The canonical private destination is
the existing Monad-origin asset:
`nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`.
Different USDC Aurora asset IDs do not become interchangeable merely by sharing
a symbol. Base/Arbitrum routes must explicitly convert to this destination.

Retain existing pins, subject to per-network deployment and provider qualification:

- EntryPoint 0.8: `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.
- Simple7702: `0xe6Cae83BdE06E4c305530e199D7217f42808555B`.
- Pimlico ERC-20 paymaster: `0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402`.

Base and Arbitrum are funding origins. Existing Swap destination chains remain
4663 and 8453; existing Earn profiles remain unchanged. In particular, a funding
`sourceChainId` must never overwrite the current target `chainId` field. New
cashout destination networks, Avalanche, X Layer, USDC.e and arbitrary tokens
are outside scope. Existing sells, withdrawals and legacy private accounts must
continue working; do not silently pool different confidential owners.

## Repository findings that require implementation

- `core/src/source_planner.rs` rejects duplicate account indices/addresses and
  has no chain/token key. Account 1 across three chains currently collides.
- `core/src/swap/funding.rs`, backend Pimlico adapters and native funding
  planners pin Monad. Domain signatures, nonces, approval token, code checks,
  fee policy and receipt lookup all need source-network qualification.
- `core/src/swap/engine.rs` currently uses one `source_asset` as both the public
  origin and private asset. Separate these before requesting cross-asset routes.
- Android `SwapFundingBatch.kt` completes a full Swap for each source. It needs
  a funding-credit barrier followed by one downstream action. Preserve the old
  version's behavior for saved operations.
- Android `EarnDepositCoordinator.kt` already waits for all funding credits,
  and its existing public-funded branch tracks transfers per source × recipient.
  The existing private-funded branch already handles spending private USDC.
  Route the combined credited amount through that branch instead of adding
  a new payout type or redesigning its transfer/distribution rules.
- That balance-funded Earn adapter is currently Robinhood-only. Ethereum Earn
  retains a separate legacy controller and individual source-credit proof path.
  Its handoff requires an explicit extension of the existing private-balance
  adapter/native allowlist for Ethereum USDC; liquidity/vault execution and
  stage approvals remain unchanged. Do not silently exclude it or describe that
  handoff as already supported.
- Backend `ConfidentialSettlement` already issues portable, bound source-credit
  envelopes that survive later spending/restart. The native source journals and
  shared-credit guards provide ordered recovery; existing Postgres operation
  coordination also binds immutable claims. Its in-memory occupied set alone is
  not durable locking, but it is not the only existing safeguard. Extend the
  current mechanisms before considering another ledger. Minimum-return receipts
  retain their distinct semantics.
- Swap's private-funded mode currently sizes execution from the whole available
  private balance. Bind the approved combined amount at the handoff so a partial
  budget cannot sweep unrelated private funds; retain the existing trading rules.
- iOS has a single-operation Swap journal, lacks Android's funding batch and
  reservations, and caps new Swap input at 10,000,000 atoms. All three need
  explicit handling for the 15 USDC cross-source example.
- `MainnetPortfolioSnapshot`, its JS validator and USDC valuation assume chain 143. Add a versioned multi-network observation without changing the meaning
  of legacy `totalAtoms` underneath old callers.
- `AddFunds` already has a network picker: extend it. Audit existing Swap/Earn
  network badges/copy so ordinary action screens remain chain-abstracted. Keep
  issuer/product distinctions and internal chain/address token identity.

Paths in this section under `core/` refer to
`mobile/modules/gizu-stored-signer/core/`.

## Settlement limits and recovery

The current evidence is route status + origin receipt + authenticated balance
delta within quoted bounds. It is not a uniquely attributable private ledger
receipt. Serializing app-controlled incoming routes reduces ambiguity; unrelated
external activity can still make attribution uncertain. Do not claim that pooling
eliminates this limitation or introduce guessed credit for a new network.

Reuse existing encrypted source/parent journals, bound source-credit envelopes,
shared-credit/payout guards and operation coordination. Persist each credit before
advancing, and make the new source children visible to the existing guards.
Never reuse one observed balance increase for two child credits or release signed
work/reset its baseline merely because authorization expired. Reauthentication
refreshes authority while retaining the original evidence. Ambiguous credit pauses
with recoverable funds; it does not start downstream execution. Without `/history`,
some ambiguity may still require provider-assisted reconciliation; never label it
settled. Expiring coordination claims are not permanent signed-work ownership;
do not introduce a global lease/ledger system without a demonstrated unmet need.

Cancel before submission releases unused reservations. After submission,
reconcile before releasing ownership; do not promise an automatic cross-chain
refund. An unfinished pool does not create a second asset balance in the UI.
Exclude reserved funds from new spend planning and avoid counting source cash,
in-flight transfer and destination credit simultaneously.

## Qualification and release conditions

Provider documentation supports reusing EIP-7702 on Base and Arbitrum with
EntryPoint 0.8. The existing-account flow is described in
[Pimlico's guide](https://docs.pimlico.io/guides/how-to/paymasters/sponsor-transaction-fees);
USDC-paid gas is described in
[its ERC-20 funding guide](https://docs.pimlico.io/guides/how-to/payments/send-usdc-without-eth).
These are integration references, not proof of Gizu's complete route.

Live public checks confirmed exact token/paymaster support, deployed pins and
Base/Arbitrum origin-to-canonical-private quote availability at 5- and 10-USDC
route inputs. Gizu's already-configured proxy and Pimlico public endpoints allowed
these checks without local provider keys. Quotes were unfunded and did not prove
private settlement. A 0.10-USDC Base quote was rejected, so minima cannot be
assumed identical across networks or copied from Monad.

Before enabling either new network, qualify concrete UserOperation gas estimates
including rollup overhead, source-specific refund/expiry behavior, authenticated
private settlement, interrupted recovery and a bounded end-to-end funded journey.
Do not expose the networks until backend and native capabilities are ready. Keep
unavailable checks explicitly blocked; do not invent successful fixtures or ask
for secret values in chat.

Read-only and deterministic tests may proceed without credentials. Paid
qualification transfers, production enablement and deployment require a concrete
funded test/release procedure and the user's authorization at execution time.
