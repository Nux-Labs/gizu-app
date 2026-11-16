---
id: investing
title: Investing
description: What you can invest in with Gizu and how an investment is confirmed.
---

# Investing

Gizu brings onchain investments from different chains into one app. You pick the asset; Gizu takes care of the chains, conversions and wallets in between.

## What you can invest in

- **Tokenized stocks.** Onchain versions of listed stocks, traded on Robinhood Chain.
- **Yield vaults.** Strategies from lending protocols such as Morpho, Curvance and Aave, curated by third parties.

More asset types and chains are added over time. See [Supported chains & protocols](./supported-networks.mdx) for the current list.

## Before you invest

For every asset, Gizu shows you what you need to decide:

- The asset and the chain it lives on
- For vaults: the strategy, the curator and the deposit asset
- Fees and limits for the route
- The amount you are about to invest

An asset appearing in the catalog doesn't guarantee it can be bought at any given moment. If a quote or liquidity isn't available, the app tells you before you confirm.

## Confirming an investment

When you confirm, Gizu:

1. Moves the amount from your USDC balance into your confidential balance.
2. Distributes it to one to five fresh wallets controlled by your passkey.
3. Buys the asset or makes the vault deposit from those wallets.

You approve the whole operation once with your passkey. If an operation is interrupted, Gizu keeps its progress and lets you continue it later; you may be asked to approve again.

:::warning Investment risk
Onchain assets can lose value. Vault returns come from the underlying strategy, vary over time and are not guaranteed. Privacy protects information about your investments; it does not remove investment risk.
:::
