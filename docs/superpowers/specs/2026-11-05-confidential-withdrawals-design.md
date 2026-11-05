# Confidential proceeds and distributed public withdrawals

Approved by the user's November 5 conversation: build the agreed flows now.
Incoming and existing public USDC and purchase/deposit funding remain unchanged.

## Behavior

- New vault exits redeem every saved investment portion and return proceeds to
  authenticated confidential Monad-origin USDC. Public receiving payouts are not
  part of a new vault exit. Existing signed public withdrawals remain recoverable.
- New sales sell all selected holdings, verify each inbound route's confidential
  USDC credit and finish privately. Old saved sales retain their public payout
  policy. A provider route status or aggregate account balance alone is not a
  sale-specific settlement proof.
- A separate **Withdraw from Gizu** action takes an exact private-USDC input
  budget, runs the existing native 1–5 wallet allocation algorithm once and pays
  public USDC on Monad to fresh user-owned receiving accounts. The user does not
  choose an outside recipient in this revision.
- The withdrawal distribution, source budgets, recipient indices and quote bounds
  are saved before signing. Native review shows the input budget, source count,
  recipient count/amounts, fees and guaranteed net output. No JavaScript secret or
  spending signature and no automatic financial approval.
- Retries preserve recipients and signed payloads. Unknown submission is checked
  before rebroadcast of identical bytes; it never causes a new allocation or a
  duplicate payout. Changed unsigned fees/terms require another native review.

## Architecture

Retain the swap confidential account and separate Earn cycle confidential
accounts. Use the existing native aggregate catalogue, including discovered
accounts, for authenticated private cash selection; never send the catalogue to
the backend. Reuse generic Aurora quote/intent/submit routes, with new authenticated
history and cashout preparation/status endpoints. Use native TLS response
validation, deterministic key derivation and durable encrypted journals.
Existing returned-child withdrawal signers remain strict; generic
cashout gets a separate native plan/signing policy rather than weakening them.

Native source selection uses fresh authenticated private balances and exact
integer amounts. Public source wallets are never used by cashout. Total source
input equals the chosen budget; payout inputs partition that budget exactly,
with integer remainder assigned deterministically. Provider fees reduce received
output, and minimum output is explicit. Reject dust/invalid plans without reroll.

Private spending needs a shared persisted exclusion/reservation boundary. Unfinished
buys, deposits, private payouts, legacy withdrawals and cashouts must not spend
the same confidential funds. Pending or unknown signed work keeps its lock;
unsigned cancellation can release it. Do not treat cached portfolio values as
spending evidence. Native execution must recheck source identity and bounds.

UI separates private cash, invested value and public receiving balances. Moving
between them changes allocation, not profit or the total twice. Refresh private
balances after credits and payouts; incomplete/locked reads remain explicit.
Expose one vault position, internal sequential exit progress, and one cashout
progress view with per-recipient states. Preserve the current visual language.

## Migration, recovery and limits

New sale policy is explicit and versioned; absence means legacy public payout.
Never reinterpret saved signatures, recipients or approvals. Existing vault
public payouts have resume/reconcile controls but new vault exits do not create
them. Private accounts and public receivers use existing derivation domains and
registry high-water marks so backups/discovery keep finding them. No seed format
change, backend wallet catalogue, retained addresses, production deployment or
funded transaction is authorized by implementation/testing.

Android is the connected execution platform. Unsupported native platforms must
advertise unavailable capability rather than simulate successful withdrawal.
Incoming public USDC, original public funding selection and new private-cash
reinvestment are outside this revision.

## Deployment and bounded operation

Deploy the backend with `POST /v1/swap/aurora/history` and
`POST /v1/earn/native/cashout/{prepare,status}` before exercising the updated app.
New sales probe history before any financial review, Fusion permit or order.
The hosted history endpoint returned HTTP 404 during the implementation check;
the local backend changes have not been deployed.

Cashout settlement also needs the existing durable PostgreSQL coordination store
and stable `EARN_GATEWAY_RECOVERY_KEY`. Canonical receipt transaction/log events
are atomically bound to one child using effectively permanent keyed commitments.
Only opaque digests persist in that table; no raw addresses or user-wallet
catalogue is added. This deliberate replay-protection boundary is stateful.

Current bounds are 32 private sources, 1–5 new receiving wallets, at most 36
transport children, an 8192 receiving-index high-water, and an 8 MiB local journal.
Terminal history is retained without compaction. Quotes last at most 60 seconds;
large sequential preparations may need another review with the same distribution.
Unavailable or ambiguous evidence fails closed. These limits and provider
compatibility need operational qualification; automated verification does not
submit user funds or establish successful live settlement.

## Alternatives and choice

Automatically paying vault/sale proceeds publicly contradicts the user's privacy
rule. One consolidated confidential account creates unnecessary internal transfers
and abandons existing cycle ownership. The selected approach keeps confidential
accounts separate and aggregates them for display and explicit distributed cashout.

## Acceptance

Test private completion for both vault chains and new sales; legacy saved-sale
resume; exact partial cashout from multiple private accounts; all algorithm sizes;
fees/dust/insufficient funds; cancelled/rejected approval; restart before signing,
after signing and after ambiguous submission; competing spending; malformed or
stale evidence; partial payout settlement; no reroll/replay; old backup discovery;
account-switch cancellation; and unchanged incoming/public-funding behavior.
Run JavaScript, Kotlin and Rust checks and independent review. Build the standalone
Render app and update the phone in place if connected, without submitting funds.
