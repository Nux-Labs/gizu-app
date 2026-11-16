---
id: passkey-wallet
title: Passkey wallet
description: How the Gizu passkey wallet works, why there is no seed phrase and how recovery works.
---

# Passkey wallet

Gizu is a **self-custody wallet** secured by a passkey. You hold the keys; Gizu never does.

## No seed phrase

Most crypto wallets ask you to write down a 12 or 24 word seed phrase and keep it safe forever. Gizu doesn't. Your wallet keys are derived on your device from your passkey, so there is nothing to write down and nothing to lose on a piece of paper.

## Unlocking with a passkey

A passkey is the same technology many apps use for passwordless sign-in. You unlock it the way you unlock your phone:

- Face ID or Touch ID on iPhone
- Fingerprint or screen lock on Android
- A supported passkey manager

:::note Supported passkey managers
Gizu needs a passkey feature called PRF to derive your wallet keys. Major platform passkey managers support it, but not every third-party passkey manager does. If your passkey manager isn't supported, the app will tell you during setup.
:::

## Approving transactions

Every investment, sale and withdrawal is signed on your device after you approve it. Gizu shows you what will happen, including the amount and the wallets involved, before it asks for your passkey.

## Backup and recovery

Gizu keeps an encrypted backup of your wallet setup. To recover your wallet on a new phone, you need **both** the encrypted backup and your original passkey.

:::warning
If you lose access to your passkey, Gizu cannot recover your wallet for you. Keep your passkey synced through your passkey manager so that it survives a lost or replaced phone.
:::
