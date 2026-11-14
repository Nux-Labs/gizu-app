# Aurora flow in the app

Source reviewed 2026-11-14. This page describes the current native swap flow. The
existing illustrations are retained historical assets; diagram updates are deferred. **F** is the Monad funding wallet; **C** is the app's confidential Aurora balance. Aurora converts between chain assets; 1inch Fusion handles the stock-token trade on Robinhood Chain.

For component ownership, contracts and durable recovery, see
[Swap architecture](SWAP_ARCHITECTURE.md).

## Buy: Monad USDC to a stock token

![Buy flow: Monad USDC travels through Aurora Confidential Intents before 1inch Fusion buys the selected stock token.](../images/aurora-buy-flow.png)

The app requests an Aurora quote before asking for approval. After approval, funding wallet **F** sends USDC on Monad to the quote's deposit address. Aurora settles that deposit into **C** using Confidential Intents. The app then requests payouts from **C** to the reviewed Robinhood Chain wallets.
Public-funded buys choose one to five recipients using the amount-aware native policy;
the count and weights are saved before approval. Existing-private-balance buys retain
three recipients. The buy illustration shows the older fixed-three example. Each wallet signs a 1inch Fusion order that swaps its USDG for the selected stock token.

## Sell: stock token back to Monad USDC

![Sell flow: stock tokens are sold through 1inch Fusion, routed through Aurora Confidential Intents, and returned as USDC to fresh Monad wallets.](../images/aurora-sell-flow.png)

The normal sell form selects the token's full eligible owned holder set, including
partial allocation groups and excluding Earn recipients. For each funded holder,
native code estimates the Fusion sale and requests an Aurora quote for its USDG
proceeds. Native review authorizes the saved holders and route; each holder signs
a permit and Fusion order sending USDG directly to that quote's deposit address.
Authenticated Aurora operation history must match those verified transfers before
native code counts USDC credit in **C** (confidential Account 2).

The current return path is **stock token → USDG on Robinhood Chain → verified
private USDC credit in C**. A full-holding sell stops there, with zero public payout
legs and no fresh Monad recipients. **Withdraw from Gizu** is a separate,
Android-capability-gated operation that can distribute a chosen private-cash amount
to fresh Monad receiving wallets after its own review and approval.

The unchanged sell illustration depicts a legacy public-return sale. Those saved
operations retain their original Monad payouts and remain resumable; it does not
describe new full-holding sales. Public status/history distinguishes the two using
`completionTarget` and `privateCreditedAtoms`.

## What is and is not private

The source-chain funding transfer and destination-chain payouts are still public transactions. The confidential balance and its internal transfers do not appear as ordinary balances on those chain explorers, which is intended to make it harder to connect the funding wallet to the final wallets. This is not guaranteed unlinkability: Aurora and service providers can observe parts of the flow, and timing, amounts, or shared transaction patterns may let outside observers infer relationships.

The relevant implementation is in [the Aurora quote builders](../../mobile/modules/gizu-stored-signer/core/src/swap/aurora.rs) and [the swap state machine](../../mobile/modules/gizu-stored-signer/core/src/swap/engine.rs). For a concrete mainnet example with transaction hashes and observed visibility, see [the transaction-by-transaction research note](../../research/outputs/confidential-swap-tx-by-tx.md).
