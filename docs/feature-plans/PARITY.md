# Gizu product capabilities and parity

Updated 2026-10-05. Existing frontend-inspired mobile design is retained;
service availability differs by mode.

The native-mode entries describe the stored-wallet signer; platform differences are noted below.
Platform acceptance and remaining migration work are tracked in
[the migration plan](../internal/SIGNER_MIGRATION.md). Historical fixture journeys remain in tests and the isolated UI playground;
simulated passkey startup has been removed.

| Journey                         | Normal native mode                                                             | Test/preview fixtures                        |
| ------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Welcome/access                  | Native passkey create/open; Account 0 viewing session                          | Simulated passkey access                     |
| Request access                  | Development mock; no real waitlist submission                                  | Same mock                                    |
| Home                            | Observed portfolio value in USD, error/retry, address actions                  | Fixture portfolio and charts                 |
| Vaults                          | Read-only mainnet catalog, TVL charts and details; no signing                  | Search/filter, details, charts and sharing   |
| Swap                            | Read-only live token catalog in development and TestFlight                     | Read-only token catalog                      |
| Receive                         | Receiving address/network/copy; no signing                                     | Simulated transfer journey                   |
| Send                            | Mainnet USDC transfer execution unavailable                                    | Simulated review/signing/result              |
| Activity                        | Mainnet USDC indexing unavailable                                              | Fixture activity                             |
| Confidential Earn               | Native intent/read flows; Android execution; iOS Ethereum vault execution only | Adapter and real-screen fixtures             |
| Account                         | Real address/copy, local preferences, disconnect                               | Fixture profile and secondary pages          |
| Notifications/support/documents | Unsupported service actions guarded                                            | Local fixture interactions, no real delivery |

Native sessions mount no mock financial providers. Unsupported balances/positions
are not zero-valued fictional holdings. No standalone wallet product UI is added.
Incoming and external history indexing is deferred. Core supports broader bounded
native diagnostics, but that does not expand the main-app product scope.

## Mainnet app flow on the confidential-swap branch

Normal stored-wallet onboarding now creates a `mainnet` session for the existing
swap funding account (index 1, Monad chain 143). It does not create a new wallet,
move funds, change derivation, or expand the native testnet transfer policy.

- Android and iOS Home use shared Rust rules for Monad USDC (6 decimals), covering
  accounts 0, 1 and allocated public recipients. Account 1 is the funding amount;
  all other included balances contribute to the remainder. Confidential account 2
  is excluded. Both show the same totals and breakdown. Android retains its
  incremental encrypted cache and incomplete/stale indicators; iOS requires a
  complete read at one finalized block and retains the previous UI snapshot on failure.
  Returned USDC is not automatically consolidated or spendable from the funding account.
- Home shows one USDC total, with separate collapsed Balance details and Wallet details.
  Wallet actions use Receive/Send; investment flows keep Deposit/Withdraw. The Home
  Confidential earn shortcut is temporarily hidden; the Earn route is retained.
- Receive shows the mainnet USDC funding address; Settings omits the funding account card. Activity shows local
  archived buy/sell summaries, including completed sales' USDC proceeds. It does not
  claim complete incoming history or reconstruct overwritten historical records.
- Direct mainnet Send has no amount, review or signing controls. It explains
  the unsupported operation and shows the current accounts instead.
- Normal app composition never mounts the testnet balance/transfer provider.
  `npm run debug:testnet` explicitly opens the retained Account 0 testnet harness;
  the debug entry is rejected outside development. Old native testnet RPC and
  transfer policies remain intact for that harness.
- iOS registers `getMainnetPortfolio` for public Monad USDC and returns locally
  recorded completed/cancelled swap history. Earn portfolio extensions remain
  Android-only. Physical-iPhone acceptance is still pending; see
  [GIZU-1 verification](GIZU-1_IOS_MONAD_PORTFOLIO.md).

## Confidential-swap holdings: Android and iOS

Swapped Robinhood tokens appear on Home as ordinary asset rows; Home has no separate
holdings section and always shows the **Earn** vault preview below the assets. Selling a
swapped token happens in Swap's sell mode, which reads swap holdings through the native
adapter after its swap capability check. Loading and failures do not imply an
empty portfolio. Home no longer shows the Wallet details toggle; account details remain
available on Receive/Send. Home totals public and private USDC, owned stablecoins,
and valued vault positions in USD. This branch's Swap tab uses the native confidential-swap
journey; the read-only Swap row above describes the earlier catalog baseline.

Android keeps a swap asset ledger: every token a swap approves is recorded with its chain, and
the ledger is part of the encrypted wallet recovery catalogue, so a restored wallet keeps its
swapped stocks and swap history. Ledger tokens are read through Multicall3 in one pinned block.
After the first balance read Home runs a read-only recovery sweep: native checks every
swap-listed catalogue token (`GET /v1/token-addresses`) against the wallet's own swap recipients
and adds held tokens to the ledger. It runs once after a restore and then at most daily; tokens
outside the catalogue are never discovered. iOS has no recovery catalogue yet and skips the sweep.

- Wallet, holdings and catalog errors use plain-language messages with read-only retry
  actions and expandable fixed diagnostic codes. Raw provider errors are not rendered.
  Sale failures direct users to Swap for status review rather than resubmitting a sale.
- Holding cards show the token symbol, amount and verified value when available.
  Swapped stocks without a native valuation use the catalogue's market price (refreshed with
  the balance, at most every five minutes) for an estimated USD value shown with the share
  amount and included in the Home total; a stock without a market price shows its amount only.
  Assets are ordered by USD value, unpriced holdings last. A stock's detail shows its name,
  market price only (the row already shows value and shares), without chain, contract or check
  time, and **Sell** opens Swap's sell form with that stock chosen. Other rows add no shortcuts;
  Receive, Send and Withdraw already sit above Assets. A complete read with no holdings and no public USDC shows **No assets yet**
  with **Buy a stock** and **Receive USDC**.
  Missing valuations are never treated as zero. Supported USDC and USDG retain their
  dollar face value when market pricing is unavailable; verified USD prices take precedence.
  The USD total retains the latest observed private/token balances when reads expire or
  require authentication. Asset rows show a logo and one value; tapping the row opens
  amount, network, contract and check-time details. Private USDC carries a lock badge.
  The read-only action is labeled **Refresh private balance**, with native authentication
  when its permission has expired. Missing-value notices stay in the affected asset's details.
  Missing amounts remain unavailable, and refresh/unlock updates the observation.
  Performance history uses a separate USD series from older USDC-denominated totals.
- Native storage keeps tracked token contracts and completed/cancelled public
  operation summaries in a separate encrypted, wallet-scoped portfolio file.
  Replacing the active swap does not replace these records.
- Holdings are ERC-20 balances at one RPC block across all locally allocated
  recipient accounts. Refresh does not sign or advance an operation. RPC errors
  retain visible previous results with a stale warning and disable selling.
- **Find an earlier purchase** selects a token from the existing swap catalog and
  checks its balances, recovering holdings whose old operation record was replaced.
  Discovery covers selected/tracked tokens and locally recorded account indices,
  not an exhaustive cross-device asset index or historical transaction ledger.
- Selling uses a native-validated group of three allocated holder accounts, freshly
  checks balances in Rust, allocates new return accounts, and requires native review
  and passkey approval. An unfinished operation must be resumed through Swap first.
  Multiple groups are sold one at a time; no automatic sale is started by refresh.
- Both platforms use Rust for account selection, exact token totals and sell-batch
  ownership. iOS persists tracked tokens and public history independently of the
  active operation and backfills the remaining legacy operation on first read.
  The portfolio file is local, outside the wallet backup format; the original
  account registry and token selection are needed to rediscover balances after restore.

- iOS now exposes selected-holding sales, explicit recovery and private-balance
  payout through the existing Home and Swap screens. Recovery resumes unfinished
  work instead of replacing it; a new recovery scans at most the last 60 allocated
  accounts, matching Rust's existing limit. It is not full chain-wide discovery.
- iOS keeps the native dialog open during bridge polling. Closing/backgrounding
  cancels local work and drops signing authority; it cannot undo a submitted step.
  Status reads never retry; explicit Resume clears a pause and obtains native
  review/passkey authorization when the core requests it. Swap ceremonies last at
  most 15 minutes; ordinary wallet ceremonies retain their two-minute limit.
- Shared fixture tests and native simulator tests cover these implementations.
  Real iPhone passkeys, funded sell/recovery and background/resume still need
  device acceptance. Android's multi-source buy funding and Earn execution are
  outside this parity change.

## Data and state boundaries

Wallet access itself is local. Confidential balance checks use a separate, native
read-only authentication; aggregate balances do not prove operation settlement.
Source balances come from RPC; transaction
history is not a complete chain ledger. Unknown/pending native entries block new
transfers until reconciliation. Closing a screen cannot undo a submitted operation.
Legacy journal details remain missing when never recorded. Preferences are local,
not credentials; see [Account](../internal/ACCOUNT.md). Fixture transaction semantics remain
explicitly demo-only; see [Trading](../internal/TRADING.md).

## Product and interaction decisions retained from agent guidance

These feature-specific decisions live here so engineering instructions can remain
focused on reusable approaches. They supplement the journey statuses above.

- Access is passkey-only. Native sessions are memory-only; simulated sessions are retained for tests.
  Restart/disconnect clears access; protected links cannot grant it. Developer UI
  previews are hidden from normal navigation and opened by explicit debug commands.
- Keep user-facing copy free of demo/simulated prefixes and repetitive banners.
  Preserve engineering mock provenance and labeled native share summaries; do not
  claim actual biometrics, credential creation, connectivity or settlement.
- In demo mode, use a session-scoped investment snapshot. Charts are performance indexes using
  fixture windows, not market history or executable quotes. Preserve old snapshots
  with stale/offline feedback after refresh failure; metadata comes from adapters.
- Demo vault search combines name, ticker, strategy, manager and risk. Preserve search/filter
  and chart selections across navigation; show Clear only when applicable. Advanced
  filters remain unavailable until specified. Share text without inventing a public
  URL or treating share-sheet dismissal as delivery.
- Hide all top navigator headers. Place accessible screen titles and Back controls
  in content, with safe direct-link fallbacks. Keep bottom tabs on main screens.
- Bottom navigation is a floating capsule over a transparent overlay. Reserve its
  measured height in scroll padding and pass touches through outside the capsule.
  It matches the frontend glass capsule (19 px icons, inactive white/45) and enters
  from 60 px below with a 260/26 spring. Selection slides a
  measured neon pill with a 380/30 spring. Motion follows accepted navigation,
  retargets on interruption and does not replay on repeated selection; reduced
  motion skips the entrance and snaps the pill.
- Stack screens use a native 350 ms fade approximating the frontend's shift/blur
  fade (native stacks cannot blur). Modals keep the platform sheet transition;
  native back and swipe dismissal are unchanged.
- Prioritize balances or vault identity before metadata. Vault tiles show ticker,
  change, chart, name, TVL and APY; use one column for narrow/large-text layouts.
  Keep financial values readable and feature state intact during text-size changes.
  On Home, show vault summaries only when there are no holdings; invested users see
  their holdings without the duplicate discovery list. Vaults always owns the full catalog.
- Request access validates email, one investment range and at least one platform
  or Other. The range is not a commitment. Preserve answers on retry, lock controls
  while pending, ignore late results on dismissal and clear answers on reopening.
  Completion is user-dismissed. Its mock creates no real waitlist entry or session.
- Exchange keeps its route/deep link and Swap tab label. Development and TestFlight use `GET /v1/tokens` for read-only discovery: Ethereum (1), Monad (143), Robinhood (4663); Robinhood/RWA defaults, All/RWA filters, 300 ms search debounce and infinite scrolling in 20-item batches. Network changes preserve search/category and reset the list. Two-column cards show token symbol/name, issuer, classification and 1inch listing, with contract addresses hidden; listing is not confirmation of Fusion availability. Quotes, balances, simulations, orders and signing are absent. Wallet network and signer capabilities remain unchanged. Missing configuration, backend 404/503 and malformed responses show unavailable/retry without fixture fallback. The public backend has not yet exposed the endpoint; service-mocked checks do not establish live readiness. Demo buy/sell remains available from vault details; native buy/sell is unavailable.
  Receive/Send remains available from Home, with explicit review, signing,
  submission, pending/unknown and result states.
  Notifications/account actions are implemented in M5; use a distinct sell tone without
  making successful sales look like failures. See `TRADING.md` for current rules.

- Welcome follows the frontend Onboarding: a fixed, non-scrolling, full-bleed screen
  (safe-area padded) over the shared Skia wave field and an ink scrim. The wave renders
  at about 1.5 device pixels per point (smaller canvas scaled up, like the frontend DPR
  cap), pauses while Welcome is unfocused or the app is inactive, and shows a still
  frame under reduced motion. The large Gizu symbol artwork is no longer shown.
- The 46 pt headline enters as in the frontend: “DeFi in” at 150 ms, then “Stealth”
  and “Mode” at 0.85 s + 0.3 s per word (280 ms each, opacity and rise in place of
  blur), tagline at 1.5 s and the wallet actions at 1.7 s. “DeFi” and “Stealth”
  use the shared glitch label; “in” and “Mode” are 55% white. The header is read as
  “DeFi in Stealth Mode”. Entrances do not block pressing, glitching stops off-screen,
  in the background or with reduced motion, and text sizes above 130% keep native
  heading wrapping without glitch slices. Negative display tracking applies on iOS only;
  Android mis-measures tracked text and can clip a wrapped word.
- Welcome follows the local wallet: with none it offers Continue with passkey and Restore
  wallet from backup; a readable wallet shows only Unlock wallet, since restore never
  replaces it; an unreadable wallet explains why and offers only restore. The actions stay
  at the bottom with safe-area padding.
  Errors and cancellation remain available, and native verified backup remains required.
  The separate Access screen is removed; old signed-out access links open Welcome.
- Request access remains a sentence-case text action for the demo flow. Request access uses the
  frontend sheet look (36 pt top radius, glass fields, range tiles, platform pills) and
  a glass check tile on completion; it keeps its completion copy because the mock
  does not add anyone to a list.

## Mainnet catalog

Native-mode Vaults loads `/v1/chains` from the backend configuration and combines the
supported chains in one catalog, with search, protocol filters, pagination,
APR and TVL. The example environment enables Robinhood (4663), Ethereum (1), and
Monad (143). There is no chain picker; Aave/Morpho/Curvance filters remain. Home previews
the combined catalog too. Each chain is paged independently; exhausted chains are not
queried again when loading more. Optional configured contracts add Morpho metadata with operator fallback
names/descriptions; details display the contract address and share symbol. The example
features Gizu Prime AUSD on Monad, independently of the native-supported Pendle USDC
Ethereum and Steakhouse USDG Robinhood profiles. `CATALOG_VAULTS_JSON` is additive
promotion configuration; an empty list removes promotions only. Explicit promotions
have a Featured label and public details, while unsupported promotions omit
deposit/withdraw actions and the deposit amount calculator. Enabled-chain selection
still controls their visibility. Only ordinary vaults with an existing native deposit profile and canonical USDC/USDG underlying
contracts are admitted; receipt/reward-token membership
and names such as syrupUSDC cannot qualify a vault. Unknown underlying assets are omitted.
Morpho underlying metadata is verified with bounded, cached lookups; Aave and Curvance
remain empty until their native deposit profiles are implemented and qualified. Missing rates, TVL and
token prices show `Unavailable`; Morpho net APY is labeled explicitly. A partial
provider catalog is marked on the screen. Cards on Vaults and the Home preview draw a
sparkline from the latest 30 TVL records (`/v1/opportunities/:id/tvl-records`), loaded
lazily per card and cached per vault for the app session; a failed history omits the
sparkline, an empty one draws a flat line only when TVL is known. Tapping a card opens the browse-only
mainnet vault detail (`/v1/opportunities/:id`): vault identity, deposit asset,
APR/APY, TVL chart, stat tiles and earnings estimate,
with loading and error/retry states. Deposit opens an in-app entry bound to the selected
vault. Exact existing Ethereum/Robinhood profile matches request a fresh native Earn
cycle after explicit intent and reuse funding/fee reviews. Vaults without an existing native deposit profile are omitted from the catalog,
including older backend responses on the phone. Unsupported direct links are rejected;
catalog metadata does not extend native execution authority. Successful detail metadata is reused for 60 seconds between
browsing and Deposit; native review still obtains fresh executable terms. A failed chain
leaves other chains visible and remains retryable. The app
never changes the funding network or extends native Earn's signing registry. Withdraw
opens existing Earn activity; it does not create a deposit cycle. Unsupported demo risk, APY and price values are not
synthesized. Backend responses may be cached for five minutes.

### Catalog scrolling

Swap and mainnet Vaults use the shared [infinite-list foundation](../internal/INFINITE_LISTS.md):
virtualized cards, automatic loading, accessible Load more, pull-to-refresh and
operation-specific retries. Vaults retain eight-item requests and responsive
columns; Swap retains two columns and 20-item requests. Filters reset results,
while append/refresh failures preserve already loaded cards. Home previews and
wallet behavior are unchanged.

### Earn native parity

The first iOS execution stage supports Ethereum vault deposits/full redemptions in the existing Earn flow, using the Android Rust policy. Native journals preserve uncertain transactions, exact-byte explicit retry, canonical settlement and cancellation locks. Source sponsorship, private payouts, Ethereum liquidity and Robinhood execution remain iOS follow-ups; this does not enable the complete iOS funding journey. See [the staged rollout](../internal/CONFIDENTIAL_EARN.md#ios-parity-rollout). Simulator/native tests and mocked bridge tests are separate from pending physical-iPhone and funded acceptance.

### Simplified native Swap layout

Swap uses a compact USDC amount card and a You receive selector opening a searchable,
virtualized token list. The Swap button sits directly below the selection and stays disabled
until the existing amount/target validation passes. The funding address remains on
Receive. Progress uses plain-language headings with expandable Swap details; resume,
cancel eligibility, recovery, native review and passkey approval are unchanged.

The Swap token picker browses the full backend catalog by Ethereum, Monad or Robinhood
network, across all categories with debounced server search and paginated infinite
scrolling. Identity is chain ID plus normalized contract address. Ethereum/Monad and
unlisted tokens are visible but cannot be selected for execution; the current native
swap route still targets Robinhood. Catalog listing does not guarantee a quote.

Pay and receive boxes share one layout (a label row with a short note, then the amount row),
so buy and sell keep one height. Without holdings, the sell side previews any swap token and
amount with a gross market estimate before fees; nothing can be swapped until it is held.

#### Swap wording

User-facing Swap copy uses one verb. Internal names (`sell`, `direction`, `startSell`) and the
native review text are unchanged.

- Never show buy, sell, purchase or sale; the action is always **swap**.
- Direction is written **FROM → TO**: `USDC → AMZN`, `AMZN → USDC`.
- Amounts pair **You pay / You receive** before a swap and **You paid / You received** after.
- Buttons are short verbs: **Swap**, **Swap to USDC**, **Swap to AMZN**, **Resume**,
  **Cancel swap**, **Open Swap**; busy buttons read **Preparing…**.
- Held tokens are **Holdings**; finished swaps are titled **Swapped FROM → TO**.

Home's Tokens and vault positions section starts collapsed. Cards, per-asset loading
messages and valuation details render only after expansion. The shared native portfolio
request still refreshes these balances alongside USDC; this is a display change, not
lazy network loading.

Android login opens the system passkey prompt directly, without the extra Open Gizu
wallet confirmation. Wallet creation, backup, recovery and transaction approvals remain
unchanged. Native changes require rebuilding the installed development client.

Settings always displays the full Wallet backup section, including instructions, steps
and Save and verify wallet backup. There is no collapse control.

Returning to Home reuses the current USDC and token-holdings snapshots instead of
refreshing on tab focus. Initial loading, manual refresh and the shared portfolio's
app-foreground refresh remain available.

Wallet bridge calls on iOS and Android now share one admission queue. Identical
in-flight wallet-state, funding-address, portfolio, holdings and swap-status reads
share a result. Explicit actions run before waiting reads; native signing and
journal/cache mutations remain serialized. Transactions are never retried by the
queue. Lock/disconnect invalidates pending work and late results; backgrounding
drops waiting requests while native code owns active system-prompt cancellation.
Swap/transfer cancellation bypasses the queue and holds new work until cancellation
and the active call settle. This prevents UI reads from racing user actions for
the native ceremony lock; it does not add parallel transaction execution.

### In-app toast feedback

Address-copy success now uses a shared Gizu toast instead of permanent inline
success text. Copy failures remain inline. Toasts have success/error/info/warning
variants, accessible dismissal, reduced-motion support and safe-area placement;
messages reset with the session. This does not add push notifications or change
the inbox. See [TOASTS.md](../internal/TOASTS.md) for customization and native-modal rules.

### Bounded balance refresh

Android Home first reads the existing encrypted native portfolio caches, without RPC
or private-provider requests, and then refreshes balances in the background. Older native
builds fall back to the network read. The initial holdings scan waits for the portfolio
snapshot so it cannot occupy the native lane ahead of the saved balance display.

Android public funding, owned tokens/positions and authenticated private balances are
read independently. Public observation RPCs have a three-second request deadline and
ten-second aggregate budget. Private refresh caps the salt lookup at five seconds, then
allows ten seconds for at most two concurrent authenticated reads; salt latency does
not consume the read phase. Cached observations remain displayed and included in the
USD total; missing observations show unavailable/retry after requests finish rather than permanent loading. Execution
and settlement validation do not use these display deadlines or cached balances.

Successful passkey login preserves its native read-only balance permission when Welcome
unmounts; unfinished access still cancels, and disconnect/background still lock it.
Robinhood portfolios with at most 80 owners refresh balances at one canonically checked
block and advance their encrypted checkpoint to that sample. Larger portfolios retain
bounded incremental scans. A moving latest block does not leave a full snapshot pending.

The native aggregate shows all owned USDG once. Swap receiving-wallet sale tools retain
their native IDs without repeating a complete owned token amount. If the aggregate is
incomplete, a fresh swap subset remains visible with its account-space label. Portfolio
and sale/account relationships remain encrypted on the device. Native Android changes
require an APK rebuild; this parity is not yet verified on iOS.

### Guided confidential deposit

Android Robinhood deposits now use Amount → Review → one bounded native passkey →
progress → verified Invested. Review creates an unsigned fresh pair without another
approval; multi-source funding shares Swap reservations and each source retains
its own credit/payout journals. Progress stops at investment. Saved investment
screens own separate withdrawal/return and funding recovery, without a new funding
input. Leaving the deposit screen revokes remaining authority, preserving signed
work. Resume refreshes unsigned economics before new native approval and never
replaces paid or signed children.

Ethereum uses the existing separately approved stage flow. iOS does not advertise
the new journey capability. The new APK requires the two read-only backend preview
routes described in [Confidential Earn](../internal/CONFIDENTIAL_EARN.md#guided-robinhood-deposit-october-11).
Render currently lacks those routes; old deployments block before funding. Mocked
functional/native tests do not establish funded provider or device acceptance.
