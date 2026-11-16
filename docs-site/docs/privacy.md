---
id: privacy
title: How privacy works
description: How Gizu keeps your investments off the record, and the limits of that privacy.
---

# How privacy works

On public blockchains, every transfer is visible forever. If someone knows your wallet address, they can usually see everything you have bought with it. Gizu is designed to break that direct link between the money you add and the investments you hold.

It does that with two layers.

## Confidential balance

When you confirm an investment, your USDC moves into a **confidential balance**. This balance and the transfers inside it do not appear as ordinary balances on block explorers. Every investment starts from there, so the path from your funds to your holdings is not visible as one straight line.

## Fresh wallets

Each investment lands in **one to five new wallets**, all controlled by your passkey. Your holdings are never collected in a single address, so no single address shows your full portfolio. In the app, you still see everything together.

## What is private, and what is not

Gizu makes your investments much harder to trace. It does not make them invisible.

| | Visible to the public |
|---|---|
| USDC arriving in your wallet | Yes |
| The transfer into the confidential balance | Yes |
| Your confidential balance and its internal transfers | No, not as ordinary balances |
| Transfers to your fresh investment wallets | Yes, but not directly linked to the USDC you added |
| The holdings in each fresh wallet | Yes, per wallet |

:::warning The limits of privacy
- **Providers can see parts of the flow.** The services that run the confidential balance and the trades can observe parts of an operation.
- **Patterns can reveal relationships.** Timing, matching amounts or repeated patterns can let an outside observer infer that two wallets belong together.
- **No guarantee of anonymity.** Gizu reduces the public connection between your funds and your holdings. It does not promise complete anonymity or guaranteed unlinkability.
:::

## Tips for stronger privacy

- Avoid investing the exact amount you just deposited.
- Spread investments over time instead of investing immediately after a deposit.
- Don't share the addresses of your investment wallets.
