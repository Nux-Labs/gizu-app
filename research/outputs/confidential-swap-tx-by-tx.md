# Confidential Swap — what we did, transaction by transaction

27 September 2026 · live mainnet run (Monad USDC → confidential balance → Robinhood USDG → AMZN)

This records a standalone Node.js harness run, not an acceptance test of today's
mobile stored-wallet app. Amounts, transactions, provider limits and the topology
below retain the dated run's scope. Current app behavior and recovery are described
in [native signer](../../docs/internal/NATIVE_SIGNER.md),
[trading](../../docs/internal/TRADING.md) and
[swap failures/recovery](../../docs/internal/SWAP_FAILURES.md).

Code: [`research/confidential-swap`](../confidential-swap/README.md). Design: [spec §6A](confidential-balance-distribution-spec.md#6a-swap-destination--robinhood-assets).

## Goal

The user should turn Monad USDC into a **Robinhood Chain Stock Token** without a public on-chain trail from the funding wallet to the wallets that hold the stock. The first proven target is **AMZN** (`0x12f190a9F9d7D37a250758b26824B97CE941bF54`). The same path applies to other liquid Stock Tokens on the list (NVDA, META, SPY, and so on).

Aurora does not pay out Stock Tokens. So the confidential leg is USDC → Robinhood **USDG**, and each receiving wallet sells that USDG for the stock through 1inch Fusion. The user does not deposit ETH or MON.

## Accounts

| Who                  | Role                                                             | Address in this run                                    |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| User                 | Sends USDC from their own wallet to F                            | user's wallet                                          |
| **F** (SOURCE)       | Holds USDC on Monad, 0 MON. Deposits into Aurora.                | `0xcd58DBfdDa39dea8cacA8592Eca2b8a637Cf4934`           |
| **C** (confidential) | Private balance on `intents.far`. Not visible on a public chain. | `0x47DA3495D8886365d454Fa989E76377adaF89391`           |
| **A1, A2, A3**       | Fresh, empty Robinhood wallets. 0 ETH. The stock stays here.     | A1 `0xF088…bCc9` · A2 `0xD04C…6786` · A3 `0x15fe…1f2C` |

F and A1–A3 use distinct keys. C's key lives in `.local/confidential-key` and is not in git. There is no A1 → A3 transfer: that would link the recipients, and the runner refuses it.

## What we used

| Piece                             | What for                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| **Monad** (chain 143)             | Source: USDC `0x754704bc059f8c67012fed69bc8a327a5aafb603`                            |
| **Aurora Confidential Intents**   | F → C deposit and C → Ai confidential payouts. `confidentiality: advanced`           |
| **Robinhood Chain** (4663)        | Destination: USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, then the Stock Token |
| **Pimlico ERC-20 paymaster**      | F's Monad gas only. Paid in USDC; F holds no MON                                     |
| **1inch Fusion**                  | Ai's USDG → AMZN order. Ai sends no transaction; a resolver pays ETH                 |
| **1inch Limit Order Protocol v4** | Permit spender: `0x5A705DE8982235a7fa45bB83dCaCf03a211389C7`                         |
| **Robinhood Stock Token list**    | `GET https://api.robinhood.com/rhj/assets` — the target set                          |

Pimlico has no USDG gas quote on Robinhood. So Ai does not use Classic 1inch plus a paymaster. This run used **Fusion (gasless)** instead.

## How anonymity is provided

The link we break for a chain observer: **no shared transaction, gas sponsor, or funding address between F and any Ai.**

1. F sends USDC to a **one-time Aurora deposit** address. The recipient is C; C is not visible on chain.
2. C's balance sits on `intents.far`. A public Monad or Robinhood explorer does not show C.
3. C pays USDG 30/30/40 to **three fresh** Robinhood wallets. The `from` on each Ai transfer is Aurora's settlement address, not F.
4. Ai holds 0 ETH and receives no gas from F. The AMZN purchase is Fusion: the on-chain `from` is a **1inch resolver**, not Ai.
5. The Ai wallets do not send tokens to each other.

That stops anyone from tracing F → AMZN as a single public transaction. **It is not proven unlinkability.**

Still visible on chain: F's Monad deposit; USDG arriving at the three Ai wallets from the same settlement sender (`0x2CfF890f0378a11913B6129B2E97417a2c302680`) in nearby blocks; the public AMZN balances in Ai. The 30/30/40 split and timing can cluster A1–A3.

Aurora sees both ends of every confidential route. The same Pimlico / 1inch API key can correlate F and Ai requests.

The active app keeps provider API credentials on the backend. Routing requests
through a backend or separate credentials does not establish provider unlinkability;
the run below is evidence of the harness's correlation limits.

## Transaction-by-transaction flow (this run)

The user sent 1.199201 USDC. A1–A3 ended with 0.002210 AMZN in total.

```
User --USDC--> F --Monad, Pimlico--> Aurora deposit
                                              |
                                         C (private)
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
                   A1                        A2                        A3
                 USDG                      USDG                      USDG
                    |                         |                         |
              Fusion AMZN               Fusion AMZN               Fusion AMZN
```

### 0. The user funds F

The user sent 1.199201 Monad USDC from their own wallet to F.

- Monad tx: `0xc92259178e7da24f573d6d5a9d9a511f7683ba8ae4a3d72d55a6bfb2e3bf4b66`
- This step links F to the user. The confidential path starts after this.

### 1. F → Aurora deposit (the only public Monad transaction)

F held 0 MON. An ERC-4337 UserOperation through Pimlico's USDC paymaster sent USDC to the Aurora deposit `0xc7e7a6F342D3B4EF26AE17e43A22F77B3dDc610B`.

- Monad tx: `0x1d01c5c21076436599664276dccec53a80488ba068cf4e13d6716004fc03d25a`
- UserOp: `0x5f12f67d…6a36695`
- Sent: 1.196276 USDC
- Gas cap: 0.002925 USDC; F kept 0.001135 USDC (too little to recover)

On chain: F sent USDC to a deposit address. C does not appear.

### 2. C is credited (no chain transaction)

Aurora writes the private balance: **1.195797 USDC**. The gap is Aurora's 4 bps `appFee`. There is no C row in an explorer. Everything after this is an Aurora intent signed by C, not a Monad transaction.

### 3. C → A1 / A2 / A3 (three confidential payouts, three Robinhood transactions)

C splits 30/30/40. Each payout is private USDC → Robinhood USDG, with a fixed **0.15 USDG** `withdrawFee`.

|     | From C (USDC) | To Ai (USDG) | Aurora intent                                  | Robinhood tx                                                         |
| --- | ------------- | ------------ | ---------------------------------------------- | -------------------------------------------------------------------- |
| A1  | 0.358739      | 0.206883     | `2UbjsqENbR6CPhqv5ZN1P7qBtXtJrUwZLAvTrjZEdmAq` | `0x8f5a5127b4e7ac1e89174e0ae8695b73bb059b53a5b97dca7a4eed3af2597636` |
| A2  | 0.358739      | 0.206883     | `HC4HsfYucJGeYCJVhdyiyP4NGh3QVqrHN1tY4DagcNRH` | `0x0c34438a492e0dec0fad86e59fbaaeac6a2de915623984659ee3dbfe1e0189bc` |
| A3  | 0.478319      | 0.325847     | `Dwiq32XYn8GMgTv7poYyysd5UyC1R8VQBu9AGzfHLjhZ` | `0x577196e5ebc256248b2182d1f4425f80a3eb82ea07858a9bdf5293e12e38ec97` |

The `from` on all three is settlement `0x2CfF…2680`, not F. A1 and A3 settled in the same block (73444041). C is empty. The Ai wallets hold 0 ETH.

### 4. Ai → AMZN (three Fusion fills; Ai sends no transaction)

Each Ai signs an EIP-2612 USDG permit and a Fusion order, both off-chain. The 1inch relayer accepts the order; a resolver pays ETH and fills it. Permit spender: Robinhood LOP.

|     | USDG sold | AMZN received | Fill tx                                                              | Block    | Resolver (`from`) |
| --- | --------- | ------------- | -------------------------------------------------------------------- | -------- | ----------------- |
| A3  | 0.325847  | 0.001050207   | `0xff460c67290adf055977a36b878218b5d9a8554cc6812e0fd8cea1971e956537` | 74203823 | `0x5A0C868E…30c7` |
| A1  | 0.206883  | 0.000580252   | `0x35d2a87c78179d8b018919ce7de4827711e20610933f6fa81cd50d1e20263f0c` | 74204144 | `0xaaaA550c…14De` |
| A2  | 0.206883  | 0.000579232   | `0xcb2f7f6ddce7c2e945ab381c1623390d45db3820e86e139fabc10e065adb888a` | 74204204 | `0xaaaA550c…14De` |

The Ai wallets sent no transaction, still hold 0 ETH, and have 0 USDG left. AMZN in Ai is public.

At this size Fusion priced resolver gas into the rate (~$0.06 per order). Around 100 USDC the same gas is a much smaller share.

## Who sees what

| Step       | User / product     | Public explorer    | Aurora  | Pimlico / 1inch      |
| ---------- | ------------------ | ------------------ | ------- | -------------------- |
| USDC to F  | User's own tx      | F is funded        | —       | —                    |
| F deposit  | “moved to private” | F → deposit        | F and C | Pimlico sees F       |
| C balance  | Private USDC       | nothing            | C       | —                    |
| USDG to Ai | —                  | Settlement → Ai    | C ↔ Ai  | —                    |
| AMZN       | Stock in Ai        | Resolver → Ai AMZN | —       | 1inch sees the order |

## Summary of this run

- In: **1.199201 USDC**
- Out: **0.002210 AMZN** across three wallets, about **$0.56**
- Fees: ~**$0.64** — mostly 3 × 0.15 USDG Aurora withdraw fees and three tiny Fusion orders
- At 100 USDC the same fixed costs plus Aurora's ~0.5% app fees come to about **1.1–1.2%**

Product claim: the user deposits USDC and receives Amazon (or another listed Stock Token) on Robinhood Chain; F and the wallets that hold the stock are not linked by a single public transaction. Aurora and the API providers can still see that link. Consolidating the Ai wallets, or placing the three orders back-to-back with the same API key, weakens anonymity.
