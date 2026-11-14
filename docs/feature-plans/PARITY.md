# Gizu product capabilities and parity

Source reviewed 2026-11-14 against the checked-in entry points, navigation,
JavaScript adapters and native wrappers. This is the current capability reference;
dated test records remain evidence only for the build and scope they describe.
No provider, deployment, funded-device or physical-iPhone acceptance was rerun.

## Runtime modes

`mobile/App.tsx` starts `AppRoot` with native stored-wallet access. Development-only
entries are `debug:ui`, `debug:stored-wallet` and `debug:testnet`; release builds
reject debug entries. Simulated passkey startup and legacy signer diagnostics are
disconnected. Fixtures remain injectable in tests; the UI playground is visual,
not a second wallet product.

`frontend/src/App.tsx` mounts the responsive landing, **Test On Mobile** invitation
form and separate **Request access** questionnaire. Both persist through
`POST /v1/early-access`; no immediate invitation delivery is configured. Retained
browser dashboard, wallet and swap components are disconnected from this entry.
Mobile's retained guest Request access route uses its own mock service and does
not persist or enroll anyone.

| Journey                         | Normal native app                                                                                            | Tests and isolated previews                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Access                          | Native create/unlock, verified encrypted backup, restore with backup and original passkey                    | Injected access fixtures; no simulated startup mode                                |
| Home                            | Observed USD total, public/private cash, tracked tokens and supported vault positions                        | Synthetic portfolio/chart fixtures                                                 |
| Vaults                          | Backend catalog, qualification, filters, paging, details and supported Earn entry                            | Fixture discovery/detail journeys                                                  |
| Swap                            | Native confidential buy, full selected-token sell, saved resume/cancel/recovery                              | Mocked public-contract and interaction checks                                      |
| Receive / Send                  | Public Monad USDC receiving address; direct public Send unavailable                                          | Historical six-decimal transfer fixtures; explicit testnet harness uses native MON |
| Withdraw from Gizu              | Separate Android private-cash distribution, gated by native capability                                       | Injected withdrawal service journeys                                               |
| Activity                        | Local completed/cancelled swap summaries; private credit and legacy public return distinguished              | Session fixture activity                                                           |
| Earn                            | Android guided Robinhood deposit and saved investment management; staged Ethereum flow                       | Service and real-screen fixtures                                                   |
| iOS Earn                        | Ethereum vault execution; sponsored funding, private payout, liquidity and guided deposit remain unavailable | Native simulator/bridge fixtures do not establish complete funding parity          |
| Account                         | Native address/copy, backup/recovery, local preferences and disconnect                                       | Fixture profile and secondary-page journeys                                        |
| Notifications/support/documents | Empty native inbox; push, support messaging and statement delivery unavailable                               | Local fixture inbox; no real delivery                                              |

Native sessions compose `MainnetWalletProvider`, `EarnProvider`, live opportunity
adapters, `AccountProvider` and an empty notification service. They never mount the
mock investment or transaction providers. Wallet access is local rather than a
backend-authenticated account session. Protected links cannot create a session;
disconnect resets account-scoped navigation and invalidates pending bridge work.

## Home, portfolio and balances

Public Monad USDC uses shared Rust account selection and exact six-decimal integer
arithmetic across Account 0, funding Account 1 and eligible allocated public
recipients. Confidential Account 2 is excluded from that public total. Home's USD
value separately includes observed confidential USDC, owned stablecoins, priced
stocks and supported vault positions without counting an owned asset twice.

Home shows a balance card, Receive/Send/Activity, **Withdraw from Gizu**, **Your
vaults**, ordinary **Assets** rows and the **Earn** discovery preview. There is no
collapsed Tokens section or Wallet details toggle on Home; Receive/Send retains
public account details. Stock rows open details with a Sell shortcut into Swap
with that token selected. Home's standalone Earn shortcut is hidden; vault details
and saved positions retain their Earn routes.

- Missing amounts and prices remain unavailable. Observed stale/private-locked
  balances remain visible with their observation state; they are not replaced by
  zero. USDC and USDG use dollar face value when verified pricing is absent.
- Robinhood stock market estimates can value an unpriced native holding and enter
  the USD total. The name/price catalog refresh is bounded to five minutes.
- Assets sort by observed USD value, unpriced assets last. Private USDC has a lock
  badge and **Refresh private balance** requests native read-only authentication
  when permission has expired. Portfolio reads do not authorize execution.
- A complete, empty read offers **Buy a stock** and **Receive USDC**. Loading or a
  failed read does not establish that the wallet is empty.
- USD observation history is local and distinct from the older USDC total series;
  it is not an indexed market-performance history or complete transaction ledger.
- Android reads its encrypted display caches first, then refreshes public,
  owned-token/position and private observations independently. Public RPC requests
  have a three-second deadline and ten-second aggregate budget; private salt has
  five seconds followed by a ten-second read phase. These display deadlines and
  cached values do not authorize settlement or execution.
- At most 80 Robinhood owners can refresh in one canonically checked block; larger
  holdings use bounded incremental scans. iOS public USDC requires a complete
  finalized-block read and retains the prior snapshot on failure. Platform cache
  and private-observation parity must not be inferred from the shared public rules.

Initial load, manual refresh, app-foreground refresh and post-action refresh share
session binding. Home tab focus reuses the current snapshot. Incoming and external
transactions are not indexed. Local public summaries and tracked contracts survive
active-swap replacement, but they are not a complete chain ledger or backup of an
installation's in-flight execution journal. See [portfolio contract](../internal/NATIVE_SIGNER_PORTFOLIO.md).

## Mobile presentation

Deposit, withdrawal and wallet recovery keep the amount, current status, fees,
limits and next action prominent. Wallet addresses, routing explanations and scan
settings open through labelled details controls. Recovery errors and the active
scan's pause action stay visible outside those controls.

Private-cash withdrawal uses a compact balance summary, a single amount hierarchy,
a human-readable status and a minimum-credit row. Zero receipts are omitted until
funds arrive; partial receipts and missing quotes remain explicit. Manual saved
progress refresh sits beside Back. Transaction signing presents the review,
passkey and signing flow with concise policy rows; its longer explanation opens
on demand and does not imply that a provider/device capability was verified.

Earn discovery uses the same logo, chart, title, TVL and APY hierarchy for every
card. An invested badge identifies an existing position; detailed balances remain
on the position screen. Token discovery cards show network, category, available
price and issuer metadata without inventing quotes. Active Swap uses the shared
particle visual, distinct running/paused states and observed order/payout counts.

Activity groups local swap records by date, supports All/Buys/Sells filters and
opens each record's reference on demand. It distinguishes completed/cancelled
records and private/public sale proceeds. Buy quantities are omitted because the
local history contract does not carry reliable token precision. Deposits and
external transactions remain outside this local history.

## Native Swap

The Exchange route carries the **Swap** tab. Its amount form, token picker and
progress/status UI call the capability-checked native bridge. Token catalog
identity is chain plus normalized contract address; listing or a market estimate
does not establish executable liquidity. New buys require a Robinhood chain 4663
stock admitted by the shared target policy and a live native-validated quote.
See [architecture](SWAP_ARCHITECTURE.md) and [contracts](SWAP_CONTRACTS.md).

Buys use public Monad USDC or the explicit existing-private-balance operation,
Aurora confidential credit, recipient USDG payouts and Fusion stock orders.
Public-source budgets can span multiple source accounts on Android with per-source
fees/reservations and child journals. iOS does not implement that Android batch
orchestration. Current public-funded buy recipient counts/weights are drawn once
from the amount-aware native policy, reviewed and persisted; retries do not reroll.

Selling a selected token sends its native `token:all` holding ID. Shared Rust
selects all allocated eligible holder accounts, including partial groups, while
excluding Earn recipients. Native code checks fresh exact holdings before review.
Current full-holding sales stop with verified confidential USDC credit in Account 2;
they allocate no fresh public return wallets and have zero payout legs. The public
status fields `completionTarget` and `privateCreditedAtoms` distinguish this from
legacy saved sales that return USDC to fresh Monad accounts. Those saved operations
retain their original terms and remain resumable.

A sale does not automatically make proceeds public. **Withdraw from Gizu** is a
separate Android operation that authenticates fresh private balances, checks
reservations and distributes a chosen amount among fresh Monad recipients. Direct
public-USDC Send remains unavailable. See [confidential withdrawals](../internal/CONFIDENTIAL_WITHDRAWALS.md).

Without holdings, the sell form can price a selected token/amount but cannot sell.
Holdings reads are read-only; failures retain previous results and prevent selling.
Explicit selected-token discovery can find earlier purchases using the saved
allocation registry. Android also runs a bounded read-only catalog-token sweep
after the first portfolio read and at most daily (or after restore); iOS skips
that sweep. Neither is an exhaustive asset index.

An unfinished operation must resume instead of being overwritten. Recovery preserves
that work or scans at most the last 60 eligible allocations for stranded USDG.
Status reads expose saved state; Resume drives execution and can obtain new review,
unlock or retry saved signed payloads. Cancellation/backgrounding cannot undo
submitted steps. Swap approval has a 15-minute signing window and core operations
retain their 24-hour lifetime; retry does not extend it. See [failure guide](../internal/SWAP_FAILURES.md).

## Vault catalog and Earn

Vaults combines independently paged `/v1/chains` catalogs without a chain picker.
Backend `VAULT_CHAINS`, optional chain metadata and additive promotions govern the
catalog; they never grant native signing authority. Supported ordinary profiles
are pinned Ethereum USDC and Robinhood USDG vaults. Unsupported ordinary vaults
are omitted; explicit promotions can remain Featured and informational with no
deposit/withdraw calculator. Monad AUSD promotion visibility does not enable execution.

Search, protocol filters, pagination, retry, lazy cached TVL sparklines and details
use live adapters. Unknown TVL/rates/prices show Unavailable, and Morpho net APY is
labeled APY. Swap's token picker and Vaults reuse the virtualized
[infinite-list foundation](../internal/INFINITE_LISTS.md); Home previews remain bounded.

Explicit deposit intent creates or resumes the selected native Earn cycle.
Android's Robinhood journey uses Amount → Review → native authorization → progress
→ verified Invested. Current native plans can split an amount among one to five
investment wallets with saved weights; older hold/invest pairs keep their saved
contract. Available private Account 2 credit is a separate source; source selection,
fee caps, reservations, per-wallet deposit/withdrawal state and allocation are native.
A preview/HTTP success is not settlement. Leaving revokes remaining authority while
preserving signed/submitted children. Saved positions own withdrawal and recovery.

Ethereum retains its staged approvals. iOS advertises Ethereum vault execution,
but not source sponsorship, private payout, Ethereum liquidity or guided deposit.
Backend preview routes and funded execution must be checked on the actual deployment;
old deployment observations do not establish their current status. Detailed amount
ladder, private funding and saved-investment rules live in
[Confidential Earn](../internal/CONFIDENTIAL_EARN.md) and [native Earn](../internal/NATIVE_SIGNER_EARN.md).

## Presentation, feedback and local state

- Screens own titles and Back controls, with no top navigator headers. The floating
  bottom capsule reserves scroll padding; detail/direct-link fallbacks retain safe
  navigation. Stack pushes use `ios_from_right`; modal sheets retain platform behavior.
- Welcome follows native storage state: create/restore when absent, Unlock when
  readable, restore when unreadable. A readable wallet cannot be silently replaced.
  Verified backup remains required. Native Android unlock opens the system passkey
  prompt directly; transaction approval is still a separate native review.
- Helvetica Neue is used on iOS; Android bundles the owner-licensed HelveticaNeue
  family. Shared semantic tokens, safe areas, text scaling and reduced motion apply.
  Welcome waves/glitch and mascot animation pause according to focus/lifecycle and
  motion settings. The Account mascot preference is device-level local state.
- User-facing Swap directions use asset pairs and **You pay / You receive**. Native
  review/internal buy/sell terms remain. Home stock shortcuts still say **Sell**.
- Account shows the real funding address and full backup controls. Push alerts is
  a local preference, not delivery registration. Currency/Statements are retained
  secondary routes but have no Settings rows; no FX or document delivery is enabled.
  See [Account](../internal/ACCOUNT.md) for persistence and disconnect boundaries.
- Copy success uses shared [toasts](../internal/TOASTS.md); copy failures stay inline.
  Transaction/recovery state remains in the screen and cannot be reduced to a toast.
- One JavaScript admission queue coalesces identical native reads, prioritizes explicit
  actions and invalidates waiting/late work on lock or disconnect. Cancellation bypasses
  the queue while blocking new work until it settles. It neither retries transactions
  nor replaces native reservations, ceremony ownership and durable journals.

Historical fixture trading, investment snapshots and notification rules are described
in [Trading](../internal/TRADING.md) and [Account](../internal/ACCOUNT.md). They do not
expand native availability. Mocked screen tests, native simulator tests, real passkeys,
funded provider settlement and physical-device acceptance are separate evidence classes.
