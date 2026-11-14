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

# Wallet-2 liquid-asset recovery — September 29, 2026

Requested recovery: Ethereum wallet `0x4943a374C5a765D33F626a9D85C265dD6287FCe5` → Monad USDC at the user-confirmed existing source `0xbFF2675Fb450c21aE1c42FEFE65999EA6f4D9285`.

This one-off recovery is separate from the confidential earn lifecycle. It uses public NEAR Intents 1Click routes. Wallet 1 is not involved. Quotes, exact local-fork simulations, signed transactions, receipts and settlement responses are saved privately in `.local/recovery/`.

Starting liquid balance: 1.731762 USDC and 0.000707811898201088 ETH. Starting Monad source: 8.003889 USDC. The old 0.133013839453606864 vault shares were not part of the requested liquid recovery and remain invested; their read-only redemption preview was 0.134157 USDC.

## Route comparison

NEAR Intents was cheapest among the usable quotes checked, including Ethereum execution gas. At the compared small amounts:

| Path                           | Measured local Ethereum gas | Notes                                                     |
| ------------------------------ | --------------------------: | --------------------------------------------------------- |
| NEAR USDC transfer             |                      57,448 | No approval; about 0.004379 USDC bridge/spread difference |
| Relay USDC approval + deposit  |                     104,641 | About 0.020480 USDC quoted route difference               |
| Across USDC approval + deposit |                     124,335 | About 0.000969 USDC quoted route difference               |
| NEAR native ETH transfer       |                      21,000 | Plain transfer to verified empty-code deposit address     |
| Relay native ETH deposit       |                      24,824 | Additional quoted route cost                              |

The Across ETH swap-and-bridge quote reverted on the pinned fork and was not used. Fusion's small USDC-to-ETH quote yielded only about 0.954 USDC worth of ETH for 1.731762 USDC input before a subsequent bridge; it was worse. Provider quotes are time-sensitive, not universal fee claims.

USDC used EIP-1559 pricing to pay the actual inclusion price. The ETH sweep used an exact 21,000-gas legacy transaction: value = current ETH balance − 21,000 × current selected gas price, verified locally with the real wallet balance. No new helper or paymaster was used.

## Execution

- USDC funding: `0xf568fd22b738d426834e8f74a0a23cad79d18c892196f06c734f0e75ed849408`. Confirmed success; actual gas 57,448, gas cost 0.000190006429307248 ETH. Monad output: 1.727383 USDC. Monad receipt transaction: `0x25239c1410eb5fd8abc167a4364adb3c4274cb2b4e2973ef654bc5b94b037f9c`.
- ETH funding: `0x1bee83336c4fcb347fb8c30ef50bd17bd63275320ce5fac4f9a36244f0de51fa`. Input 0.000450500467045840 ETH; signed gas price 3.205000088 gwei. Confirmed success; actual gas 21,000, gas cost 0.000067305001848000 ETH. Monad output: 1.201237 USDC. Monad receipt transaction: `0x38a2b495369784e90c3cdd985755b6da54f06ecf87b19e84fd37a67db27dcaf2`. Both destination USDC Transfer events were independently verified against the exact token, recipient and output amount.

The subsequent September test configuration used the same destination addresses on Ethereum and Robinhood, 10/90 confidential payout weights, and one saved 70/30 source-budget snapshot. Both recoveries settled successfully, totaling **2.928620 USDC**. Final Ethereum liquid balances are **0 ETH / 0 USDC**, with the old shares unchanged. Total Ethereum gas spent was **0.000257311431155248 ETH**. The saved Monad source balance is **10.932509 USDC** at block 109102614. `.local/test-budget.json` reserves **7.652756 USDC for Ethereum** and **3.279753 USDC for Robinhood**, including source gas. No new earn test was funded. The Ethereum test still rejects the old nonzero vault position before funding; the recovery does not bypass that check.
