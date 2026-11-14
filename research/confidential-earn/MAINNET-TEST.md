> Scope reviewed 2026-11-14: this file documents the isolated research CLI and
> dated experiments. Its 10/90 payouts, 70/30 test budgets, full-exit gas/residual
> rules and separate confidential keys do not define current Android behavior.
> Current app contracts are [Confidential Earn](../../docs/internal/CONFIDENTIAL_EARN.md),
> [requested withdrawals/refunds](../../docs/internal/CONFIDENTIAL_WITHDRAWALS.md)
> and [native Earn](../../docs/internal/NATIVE_SIGNER_EARN.md). Android now uses
> algorithm-selected investment slots, shared Account-2 private cash and read access,
> requested partial Robinhood exits, and saved terminal return/refund evidence.
> iOS has narrower execution capabilities. Recorded hashes, amounts and test counts
> below remain historical; no live probes or native builds were run for this review.

# Authorized mainnet test — September 29, 2026

Saved budgets: Ethereum 7.652756 USDC; Robinhood 3.279753 USDC. Both use the same two destination addresses and 10/90 confidential payout weights. Only wallet 2 invests. No wallet-to-wallet transfer, new helper, common application fee recipient, or joint transaction involving both destination wallets is introduced.

## Robinhood — complete, optimal residual achieved

- Source funding transaction: `0x2a2b3be973f3bbe5749fead7850a412e8a92d0f3df868ae35cf68b473925e6d5`.
- Confirmed transfer: 3.267261 Monad USDC to the quoted deposit address. Actual Pimlico gas charge: 0.001626 USDC (signed maximum 0.002626).
- Aurora advanced funding succeeded; authenticated confidential balance: 3.265954 USDC.
- Wallet 1 payout input: 0.326595 confidential USDC; actual received: 0.174875 USDG.
- Wallet 2 payout input: 2.939359 confidential USDC; actual received: 2.773924 USDG.
- Actual deposit: **2.521136 USDG**; 2.499895838304782214 shares minted. The refreshed execution plan kept a 0.175350 USDG withdrawal reserve.
- Full redemption: **2.521136 USDG**; zero shares afterward.
- Aurora return funded: **2.650000 USDG**. Aurora reported SUCCESS and authenticated private balance confirmed **2.636109 USDC**, using the original confidential Monad-USDC asset.
- Final wallet-2 remainder: **0.044207 USDG, zero ETH, zero shares**. Fresh valuation: **0.044211 USDC**, meeting both <0.5 acceptance and <0.1 optimal targets.
- Wallet 1 retains its intentional 10% payout: **0.174875 USDG**. It did not participate in the vault operations.
- Monad source remaining: **7.663622 USDC**, including the untouched 7.652756 Ethereum allocation and 0.010866 unused Robinhood source allowance.

| Operation       | Signed maximum gas charge (USDG) | Actual charge (USDG) | Transaction                                                          |
| --------------- | -------------------------------: | -------------------: | -------------------------------------------------------------------- |
| Deposit         |                         0.073750 |             0.042774 | `0xc9b55f68e8440744f76826f8bee960abc53183e062d49656b3b173a1d565f551` |
| Withdrawal      |                         0.059697 |             0.025875 | `0xd73878e17d1e230d3dff97bdbd41e45ad877fe6864d6285fc7589f874810dbb0` |
| Return transfer |                         0.025334 |             0.011068 | `0x6a039a08bbde5b823ea6c5ee8ba68123544aa3df448d569deae9cee9bad88c7b` |

Total destination gas paid: **0.079717 USDG**. Receipts show actual fee transfers to the established provider recipient, rather than a Circle-style upfront maximum pull followed by a refund. The final 0.044207 remainder is the 0.055275 return reserve minus the 0.011068 actual return charge. It includes deliberately unused reserve, not just signed-cap headroom.

Evidence: [receipt events](fixtures/robinhood-mainnet-receipts.json) and [independent final balances](fixtures/mainnet-final-balances.json).

Initial Aurora payout quoting returned HTTP 400, then a fresh unsigned quote passed. A source paymaster preparation also stopped on a rate/approval mismatch before any signature; a fresh preparation passed. The confirmed source deposit briefly remained PENDING_DEPOSIT; Aurora's optional deposit notification returned `Empty AMQP response`, but the route subsequently succeeded and authenticated credit was verified. No duplicate funding transfer was sent.

## Ethereum — complete, zero residual achieved

**Completed Ethereum mainnet cycle:** the revised Fusion order filled, wallet 2 deposited **1.084570 USDC**, redeemed all old/new shares for **1.218730 USDC**, and returned **1.268730 USDC + 0.000678997020223204 ETH** through separate Aurora intents. Both intents report SUCCESS; authenticated private credit is **3.081997 Monad-asset USDC**. Final wallet-2 balances are **zero ETH, USDC, WETH and shares**, meeting both residual targets. Wallet 1's ETH and USDC match its pre-test balances. No second Fusion purchase, helper, wallet-to-wallet transfer or joint destination transaction was used. [Mainnet evidence](fixtures/ethereum-mainnet-cycle.json).

| Step             | Amount / actual gas                             | Transaction                                                                                                 |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Fusion           | 5.121694 USDC → 0.001133295335295891 native ETH | [Receipt](https://eth.blockscout.com/tx/0x84ebe0def4280bc6bad436c8f777696c6d51b230cb0abfbed416d22955815202) |
| approve_deposit  | 0.00003079308789181 ETH at 0.554251195 gwei     | [Receipt](https://eth.blockscout.com/tx/0xd3f15d713e3d131aab284f966fc24cb7da3bfd6c650cda0c31b8d98ba5f0ce41) |
| deposit          | 0.000176694376170259 ETH at 0.568337347 gwei    | [Receipt](https://eth.blockscout.com/tx/0xf8eefbb2fe0531e7f3163e759b26ad0ddf9e6f105cd0cef3c75acb5e9d7309d5) |
| approve_withdraw | 0.000025755692155296 ETH at 0.560101169 gwei    | [Receipt](https://eth.blockscout.com/tx/0x30fdde9da342ce61ddf1edfdb8cb33a510f98f5f4ade5ca70ef47b2917f10600) |
| withdraw         | 0.00017201310622037 ETH at 0.58431739 gwei      | [Receipt](https://eth.blockscout.com/tx/0xf05040a31622f38a37250e96060524f43ce1b429a1c8f0f369c6a126f47c5998) |
| return_usdc      | 0.000033866934480952 ETH at 0.589523299 gwei    | [Receipt](https://eth.blockscout.com/tx/0xcb9a5c5a8b4b8bc56d9d06032c9adefef649a1ce856d6e7f3a40cb9a40673e88) |
| return_eth       | 0.000015175118154 ETH at 0.722624674 gwei       | [Receipt](https://eth.blockscout.com/tx/0x0267b347ddc9682b624571e448686130bb02647574b743d3da1f5f8978ab0903) |

Total owner-paid native gas across the six approval/deposit/withdrawal/return transactions: **0.000454298315072687 ETH**. This excludes resolver gas, which is embedded in the Fusion exchange terms. Purchased ETH reconciles exactly: 0.001133295335295891 − 0.000454298315072687 = **0.000678997020223204 ETH returned**. The 0.05 USDC retained during investment was included in the USDC return, not left as final dust. The returned credit is inside Aurora's confidential account in the Monad-USDC asset; it is not a public transfer to the Monad source wallet.

The custom Fusion order `0x3f4b7b95536125f34cef8d8606bb12ea396bef82d4e3fb1ed6903395b511d81f` filled on mainnet at block 26085618. The entire resolver transaction used 373,418 gas at 0.640090638 gwei; do not treat that as a separately charged wallet fee. The provider estimate used in the order budget was 587,612 gas before the configured headroom. This run proves resolver admission for these terms, not that this conservative allowance is the minimum necessary.

One preparation expired before submission. After the fill, increased fees temporarily made the fresh deposit/withdrawal reserve unaffordable; the runner sent no vault transaction. Fees subsequently fell, a transient public-RPC missing-header error was retried, and the original ETH purchase covered all six native transactions. No reserve, freshness or residual check was weakened. All six native receipts succeeded, without replacements or a second ETH purchase. The original 10/90 funding and payouts were not repeated.

Evidence captures independent receipts, exact fees, both wallets' balances, successful Aurora statuses and authenticated confidential credit. Wallet 1 was compared with block 26085617: 1.125870 USDC and 0.000030933 ETH before and after. Its intentional payout is excluded from wallet 2's residual criterion. This is one completed mainnet cycle; future gas, resolver economics and route eligibility remain variable. The previously verified suite contains 118 passing tests; this mainnet run changed documentation/evidence only.

### Earlier attempts and implementation history — superseded by the completed run above

**Pre-run resolver-economics implementation:** At this earlier checkpoint no third public order had been submitted. The runner now incorporates a custom full-fill auction priced for provider-estimated gas, gas/fee headroom and a proportional profit allowance. The old second order covered only about **0.080245 gwei** using its 202,859-gas direct-fill replay and recorded token prices, before resolver profit/routing costs. The revised local test used block 26085513 wallet state and recorded 0.675754118/1.351508236 gwei native caps: **4.648302 USDC** purchased ETH, **1.557962 USDC** deposited, and 0.05 USDC stayed liquid. It filled locally at 1/90/180 seconds at **0.844692648 gwei**, with positive modeled margins, then withdrew all old/new shares without injecting ETH into the owner. Provider gas estimate was 587,548 versus 202,485–202,600 measured for the inventory-funded direct fill. Public acceptance, actual resolver routing cost and current affordability are still unproved. This is a recorded fee scenario, not a live mainnet quote. See [pricing equation](NATIVE-CLI.md#resolver-pricing-after-the-two-expired-orders) and [evidence](fixtures/fusion-economics-lab.json).

**Latest attempt, 25th-percentile policy:** the user approved the full median of eight recent blocks' 25th-percentile tips. All 108 regression tests passed. The next production plan used **0.1 gwei priority / 0.675754118 gwei deposit cap / 1.351508236 gwei withdrawal reserve cap**. It quoted 2.886457 USDC to buy gas, leaving 3.319807 USDC investable and 0.05 USDC liquid. Submitted Fusion order `0x527bc047e3f0238c9d0f6d4fead5c8a650284bead8f76e8fb31dc7f4090d20b0` guaranteed 0.001050470836515788 ETH but expired at 20:03:32 UTC with no fills.

The exact saved order, extension and signature were replayed on a fork at preparation block 26085368 with liquidity supplied only to the resolver locally. The fill succeeded, used **202,859 gas**, debited exactly 2.886457 USDC, credited exactly the quoted minimum native ETH, left zero WETH, and preserved old shares. This proves executable order terms and settlement, not public resolver profitability/admission. [Signed-order replay](fixtures/native-fusion-signed-replay.json), reproduced by `node --env-file=.env scripts/replay-native-fusion.mjs` while historical RPC state and a matching resolver address remain available.

Latest independent read at **20:05:01 UTC / block 26085396**: **6.256264 USDC, zero ETH, original 0.133013839453606864 shares**, no active order, both Fusion attempts expired, zero native transactions. No Fusion input or Ethereum gas was spent. Public resolver settlement remains the blocker, separate from our later native transaction's 25th-percentile fee policy. [Current balances and order history](fixtures/ethereum-mainnet-progress.json).

At 19:25–19:35 UTC, lower fees allowed the authorized test to resume. A current fork using actual existing shares and pinned mainnet fee history passed before source funding. It projected 1.511376 USDC investable from the 6.193701 minimum payout at a 1.028323424 gwei deposit cap. Return-eligibility probes accepted both USDC and ETH inputs.

The source transferred 7.640235 Monad USDC in `0xa13359701c6619c3f157eeec822638df5d3fa17ae104def0686959c416d43453`, paying 0.001646 USDC gas. Aurora authenticated 7.637178 confidential USDC. Separate 10/90 payouts delivered 0.161805 Ethereum USDC to wallet 1 and 6.256264 to wallet 2. Source USDC remaining: 0.021741. [Funding/payout evidence](fixtures/ethereum-mainnet-progress.json).

A higher fee sample initially blocked the funded-wallet deposit before signing. A later fresh plan used a 0.332593217 gwei tip and 1.185350716 gwei deposit cap. Fusion order `0x2859ab5785c9ca3923b6f3304ea8378827da0838f079a17d4ac9035a6328fd26` offered 5.642965 USDC for at least 0.002027222285278474 native ETH. The order expired at 19:39:25 UTC without any fills; its expiry and unchanged balances were checked against mainnet. Two later preparations failed the reference-block freshness check before any new submission. No native vault transaction has been submitted, no active order remains, and no Ethereum gas or Fusion input was spent. The accepted estimated quote did not prove resolver execution; the provider returned no reason for the non-fill.

Final independent read at 19:43:49 UTC, block 26085292: wallet 2 holds **6.256264 USDC, zero ETH, and the original 0.133013839453606864 shares**. The new Ethereum cycle is incomplete. Source and payout route fees have been spent as recorded above; do not repeat source funding or payouts. Resume from the existing native journal only after a fresh valid gas/Fusion plan. The stale-plan retries are a separate preparation-latency issue; no freshness check was relaxed to force a submission.

The native price reader now uses the tested cache-bypass helper already used by Robinhood. A direct cached response was over 75 minutes old; the five-minute freshness policy remains enforced. The existing-share preview harness now pins real mainnet fee history so synthetic donor/empty blocks cannot lower its fee forecast. Full regression suite: **107 passed**.

The disputed 1 gwei median at block 26085239 was independently reproduced from all 2,047 receipts in blocks 26085232–26085239. Each transaction's actual `effectiveGasPrice - baseFeePerGas`, weighted by its actual gas used, reproduced the RPC's 40th-percentile values exactly. Their median is 1 gwei; the median 10th-percentile tip is 0.05 gwei. The former was a bidding policy, not a minimum necessary for inclusion. After comparing the alternatives, the user approved the full median of 25th-percentile tips, which is now implemented. [Receipt-based audit](fixtures/ethereum-fee-history-audit.json).

### Earlier affordability checks

User approved carrying the existing 0.133013839453606864 vault shares through the new investment, then withdrawing everything together. The runner records the starting share balance, checks it again before funding and deposit, simulates full redemption, and verifies the old balance plus newly minted shares against deposit events.

The production native CLI passed a local fork test with the real old position and synthetic 6 USDC funding: full redemption returned 6.134158 USDC, zero shares. Wallet 1 was unchanged. Evidence: `fixtures/native-existing-shares.json`. Regression suite after all mainnet-discovered fixes: **103 tests passed**.

Before the resumption above, the source route was quoted but not funded. Projected wallet-2 output: 6.256291 USDC; minimum 6.193728 USDC. At that gas quote, deposit plus the prescribed withdrawal stress reserve required 0.003502749828113457 ETH. Selling 6.143727 USDC (almost the entire minimum payout, retaining 0.05) through Fusion guaranteed only 0.001875671484736201 ETH. The affordability preflight stopped. It did not reduce fee bids or withdrawal reserves to force execution.

Local journals and detailed provider outputs are in `.local/ethereum/`, `.local/robinhood/`, and `.local/mainnet-preflight/`. Never delete an unresolved operation or create a replacement funding transfer merely because a provider status is delayed.

## Issues found and corrected during the live test

- Aurora token-registry caching returned prices over ten minutes old. Valuation now bypasses the cached response but retains the five-minute freshness requirement; stale origin prices still fail closed.
- Fresh return quotes intermittently returned `No liquidity available`, including alternate USDC assets. An earlier accepted quote for 2.65 USDG remained valid. The runner now supports an explicitly supplied, still-unfunded accepted quote through `ROBINHOOD_RETURN_QUOTE_FILE`. It revalidates the original assets, confidential recipient, refund owner, input amount and deadline, then obtains current paymaster estimates and enforces the same residual bounds. This run used the original Monad-USDC confidential asset, not an alternate asset.
- A quote's deposit address can remain active beyond its requested swap deadline. Quote validation, funding, payout signing, and return planning now use the earlier of those deadlines. Expired saved quotes are rejected.

All three fixes have regression tests. No extra public funding transfer was sent to work around Aurora's delays or liquidity errors. Do not reuse this run's funded return quote or delete its completed journal.

## September 30 app test funding

After the Ethereum test above, the user requested funding the phone app's Monad source from the returned Aurora confidential balance. The user explicitly approved the research configuration's 4-bps application fee/referral for this one transfer. This exception does not change the mobile Earn fee policy.

- Confidential input: **3.081997 USDC**.
- Actual finalized Monad receipt: **3.079262 Circle USDC**.
- Input/output difference: **0.002735 USDC**.
- Recipient: `0x069b3c1DD949E01504DD6Ac0a9729b730Cc87A4E`.
- Circle USDC: `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, chain **143**.
- Transaction: `0xfe7291aa5cfa443d68a08d123336d81a9702fba1bde7319ab589ce25bb663acc`.
- Receipt block: **109353503**, hash `0x294252b37491aea265f08b515cc2ba390bcf8c2238525c08c5f681d848895a9e`.
- Verification: receipt success, exact token/recipient/value Transfer, canonical block and pre-transfer reference rechecked; finalized head **109354195** exceeded the receipt block. Source balance changed from **0** to **3.079262 USDC**.

The exact signed intent was durably saved before a single submission in a separate ignored, permission-restricted funding journal. Expired unsigned quotes were archived without signing. The spending deadline was narrowed before signing; transfer amount, receiver and nonce were preserved. Earlier wallet 1 and the new app destination pair were not used as funding sources. No Earn or vault operation was authorized by this funding transfer.

Aurora's public status later reported SUCCESS. Authenticated history for this key returned an invite-only error, so operation-specific private history is **not verified**. A missing entry in the post-transfer authenticated balance response is not asserted as zero. These limits do not change the observed finalized destination receipt, but they block native Earn settlement acceptance until the provider enables history access. Superseded on October 13: native Earn now verifies source credit from an authenticated private-balance delta against a pre-signing snapshot, without history access (see the October 13–14 deposit below).

## October 13–14 in-app guided Robinhood deposit — complete

First end-to-end deposit through the Android app (one 3 USDC budget, Steakhouse USDG vault on Robinhood). It spent the September 30 funding above from the same Monad source. Wallet 1 holds the 10% payout; only wallet 2 invested.

- Monad source: `0x069b3c1DD949E01504DD6Ac0a9729b730Cc87A4E` (3.079262 USDC before funding; **0.090294 USDC** retained).
- Confidential deposit address: `0xbda541058761ec79c9e200c585e2df89d2a06ef2`; Aurora route status **SUCCESS**.
- Wallet 1 (hold): `0x7d8463F4983e80CEc924730C00871d8636B4E587`. Wallet 2 (invest): `0x2876A1d9DCB5E57f6d0F0Ff480983A6F83eCb253`.
- Private credit verified by authenticated balance delta (snapshot 0 at 13:49:01 UTC, six seconds before funding).
- Wallet 1 received **0.147037 USDG** from a 10% input of about 0.2987 USDC; a fixed route fee of about 0.15 USDC dominates this small leg.
- Wallet 2 received **2.523394 USDG**, deposited **2.340164 USDG** for **2.317044829633649623 shares**, paid **0.034941 USDG** gas and kept **0.148289 USDG** as its withdrawal reserve.

| Step                                                                                                                         | Chain          |     Block | Time (UTC)          | Amount                                                           | Transaction                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- | --------: | ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Source funding (UserOp `0xd06cf92268a516ea06b6b6a272dfc53213f6043b0b0cb084b0a05ba95f4a3699`)                                 | Monad 143      | 113056936 | 2026-10-13 13:49:07 | 2.987344 USDC to deposit address; 0.001624 USDC gas              | `0x38d14d3ca79cbdddba88b979de78eeb9fe68932c20fd87c20d867e5db37f5db9` |
| 10% hold payout                                                                                                              | Robinhood 4663 |  87844020 | 2026-10-13 21:47:02 | 0.147037 USDG to wallet 1                                        | `0x7097cba568bbf9df3f6c7b876af4dd217aa502a1a3ee61187a641bf6ab304d70` |
| 90% invest payout                                                                                                            | Robinhood 4663 |  87861593 | 2026-10-13 22:16:35 | 2.523394 USDG to wallet 2                                        | `0x18ee795a01570969dee4a301a1cef9d2bc3f99b01817058ace22a8127b75e368` |
| Vault deposit and wallet-2 EIP-7702 delegation (UserOp `0xfa04549cc8c6d5fa52efd494748fa296c964e47988adda0176a33b0a4ff81735`) | Robinhood 4663 |  87881208 | 2026-10-13 22:49:43 | 2.340164 USDG for 2.317044829633649623 shares; 0.034941 USDG gas | `0x9c436b682f58f7f5a12949c6e2b727cddcfbf7900931755db43899df62a02166` |

Both payout transactions were sent from `0x2cff890f0378a11913b6129b2e97417a2c302680` on the route's side. Both sponsored gas charges went to `0xd8baa107006c93a030d1455a2ef43261b384f21c`.

Getting here required the native and backend fixes recorded in [`CONFIDENTIAL_EARN.md`](../../docs/internal/CONFIDENTIAL_EARN.md#2026-10-14--first-completed-in-app-robinhood-deposit). No duplicate funding, payout or vault transaction was sent; every retry reconciled the saved operation.
