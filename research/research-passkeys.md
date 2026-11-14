# Historical native wallet prototype specification: confidential balance and distribution

Research baseline: 25 September 2026. This document describes the isolated
`research/combined-wallet-prototype`, not the active app in [`mobile/`](../mobile/README.md).
The fixed six-account signer, temporary RP domain and entropy-only file backup
remain prototype constraints. The active stored-wallet app has its own native
allocation, execution journals and encrypted remote recovery; see
[native signer](../docs/internal/NATIVE_SIGNER.md),
[Confidential Earn](../docs/internal/CONFIDENTIAL_EARN.md) and
[wallet discovery/recovery](../docs/internal/WALLET_DISCOVERY_RECOVERY.md).
The proposed extensions below are historical requirements, not unfinished-work
instructions for today's app. Dated provider/funded-run evidence remains unchanged.

**Historical decision:** continue the shielding and distribution prototype using our own [combined wallet prototype](combined-wallet-prototype/README.md). Wallet creation, account derivation, operation authorization, signing and encrypted backup/restore belong to the native wallet engine inside the React Native app. Aurora Intent is the intended routing integration for the next research stage.

**Prototype baseline:** the combined Android experiment contains the fixed signing
module and native recovery flow. Its source has no confidential-balance/Aurora
integration. Those proposed extensions were the next research stage in September;
the active mobile module is a separate implementation. This source review does
not report a new device test or security audit.

**Protocol baseline:** the earlier research has been recovered and the [confidential balance and distribution specification](outputs/confidential-balance-distribution-spec.md) revised for our native wallet. It preserves the Monad USDC → confidential account C → Ethereum USDC investment-wallet flow, allocation contract and Aurora-hosted quote/generate/submit path. The [endpoint verification note](outputs/aurora-signed-spending-verification.md) records evidence from 22 September 2026. A standalone 25 September mainnet test funded C from Monad and settled three confidential payouts to Ethereum; a corrected proof later authenticated C through Aurora and reconciled its 0.098009 USDC residual. Provider history is invite-only; refundable failures and Android wallet integration remain open.

## 1. Product requirements

The Earn app needs one user identity to manage a funding wallet, a confidential-balance signer, multiple investment wallets and fresh return wallets. A teammate's allocation algorithm will propose how many investment wallets to use and the amount for each. An investment or withdrawal may need more than twelve signatures at different times as routing and settlement complete.

| #   | Requirement                                    | Implementation contract                                                                                                                                                       |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One identity controls all derived wallets      | One native wallet manages account allocation and authorization without wallet switching or a separate passkey per account.                                                    |
| 2   | One unlock, many signatures                    | One native intent confirmation and passkey authentication authorize a bounded operation. Subsequent signatures may occur after delays while that authorization remains valid. |
| 3   | No wallet secrets exposed to the frontend      | Wallet entropy, private keys, PRF output and backup plaintext stay outside React Native JavaScript. Any confidential spending/viewing secrets must follow the same boundary.  |
| 4   | User control and independent access            | Normal signing requires no company cosigner. Users need recoverable wallet and protocol state plus an independently usable access path.                                       |
| 5   | No direct public ownership link                | Do not publish a shared passkey owner, root wallet identifier or registry joining all accounts. Distinct addresses alone do not guarantee transaction anonymity.              |
| 6   | One usable interface across intended platforms | The prototype implements Android only. It does not establish the active mobile app's iOS capabilities or a web secret-isolation design.                                       |

**Economic constraint:** normal signing runs locally, avoiding a hosted signing fee per signature. Gas, protocol fees, RPC, development, maintenance and audits still cost money.

**Resumption constraint:** another unlock after termination or expiry is acceptable. Losing allocations, repeating a deposit or duplicating a distribution is not.

## 2. What the combined wallet already implements

### 2.1 Wallet identity, derivation and storage

The native engine generates independent 32-byte wallet entropy with `SecureRandom`. Trust Wallet Core 4.8.3 derives six EVM accounts at `m/44'/60'/0'/0/{index}`, with indices **1 through 6**. The passkey authenticates the user; it does not generate this wallet entropy. See [WalletEngine](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/WalletEngine.kt) and [WalletCoreSigner](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/WalletCoreSigner.kt).

The entropy, registered passkey data, public accounts and operation journal are stored in an encrypted native state file using AES-GCM and an Android Keystore key. That key has `setUserAuthenticationRequired(false)`: passkey verification gates operations in native application code. This is software policy enforcement, not hardware-enforced passkey access to the seed. See [EncryptedWalletStore](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/EncryptedWalletStore.kt).

The prototype's six accounts are test accounts. Funding, investment, return and confidential-account roles have not yet been assigned or implemented. Extending account allocation must preserve existing derivation paths and persist newly allocated indices; it must not silently replace the wallet root or reuse an allocated return address.

### 2.2 Operation authorization and signing

The prototype's native operation is deliberately fixed:

- Chain ID 31337; six owned EVM accounts.
- Twelve self-transfers: six zero-wei transfers followed by six one-wei transfers.
- The second batch begins at least 60 seconds after all first-batch transfers confirm.
- Native confirmation followed by a fresh verified passkey assertion authorizes the operation. The challenge includes the operation ID, revision, action and fresh randomness.
- Authorization lasts 15 minutes in memory; the operation deadline is 24 hours.
- Signing constrains the account, self-recipient, value, chain and gas parameters.
- The engine persists signed raw transactions before submission and reconciles interrupted submissions using stored transaction information.

These mechanics provide the foundation for the next stage. They do not yet implement arbitrary recipients, token approvals, contract calls, protocol messages, confidential transfers or a general cross-chain budget policy. See [NativeWalletModule](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/NativeWalletModule.kt), [PasskeyGate](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/PasskeyGate.kt), [PasskeyVerifier](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/PasskeyVerifier.kt) and [OperationRules](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/OperationRules.kt).

### 2.3 Backup and restore

The native recovery screen requires explicit confirmation and a fresh passkey assertion. For backup, passkey PRF output AES-GCM encrypts the **existing wallet entropy** and fixed six-account derivation metadata. Android's document picker saves the encrypted JSON file. PRF output is a backup wrapping key, not the source of the wallet's account keys.

Restoration requires the encrypted file and access to the original passkey. The native engine decrypts the backup and reconstructs the same six addresses under local Keystore protection. The backup exposes format/version, RP ID, credential ID and passkey public key; wallet addresses and entropy are not plaintext fields. See [RecoveryActivity](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/RecoveryActivity.kt) and [RecoveryBackupCodec](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/RecoveryBackupCodec.kt).

The prototype backup excludes operation history. Restore deliberately creates an empty journal, so it cannot resume a distribution lost with the original device's data. Second-phone recovery is not reported as tested in the README. The test RP uses a temporary tunnel; durable recovery needs a stable domain and maintained app association. These limitations must be addressed as the wallet gains protocol balances and dynamically allocated accounts.

## 3. Responsibility boundaries for the next stage

| Component                                      | Responsibility                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Native interface                         | Present balances, proposed allocations and progress; request typed native operations. Receive public accounts, operation views and redacted errors/evidence.                                                                             |
| Native wallet engine                           | Own entropy and account allocation, verify passkey assertions, display the actual approval, enforce policy, sign and persist execution state.                                                                                            |
| Native confidential-balance adapter — to build | Implement C’s NEAR/FAR Confidential Intents account identity and ERC-191 authorization, balance access and deposit recognition through the selected Aurora gateway, without exposing secret material through JavaScript.                 |
| `ConfidentialIntentsGateway` — to build        | Use Aurora-hosted authentication, balance/history, quote, generate-intent, submit-intent and status APIs. Bind routes to approved recipients and limits, and track settlement. Maintain one C account and reconciliation model per user. |
| Allocation algorithm                           | Propose wallet count and amounts. It receives no signing authority; native code validates its result.                                                                                                                                    |
| App backend, if needed                         | Support orchestration or access to provider APIs. It must not become the owner of wallet secrets or an implicit mandatory cosigner. Record any provider availability or credential dependencies.                                         |

The [existing React Native bridge](combined-wallet-prototype/specs/NativeWallet.ts) exposes wallet status, test-wallet creation, public accounts, recovery-screen opening, operation preparation/authorization/execution/status/cancellation and redacted evidence. It exposes no generic `signDigest`, private-key export or arbitrary-calldata signing method.

Extend this boundary with typed shielding and distribution operations. Native code must parse and validate the full meaning of a request before signing. A JavaScript `approved: true` flag or opaque payload cannot grant authority. Native code, dependencies and release integrity remain trusted; this boundary does not claim protection from arbitrary native or OS compromise.

## 4. Intended flow: funding, shielding and distribution

```text
User funds an owned account
          |
Native engine prepares and confirms a bounded shielding operation
          |
Passkey authentication -> native session -> authorized deposit/signature
          |
Confidential adapter verifies the credited confidential balance
          |
Allocation algorithm proposes amounts for owned investment accounts
          |
Native engine validates accounts, amounts, route and aggregate limits
          |
User confirms distribution -> passkey-authorized native session
          |
Confidential spending authorization + Aurora Intent routing/settlement
          |
Verify each intended recipient's receipt and record remaining balance
```

The selected integration uses Aurora APIs to access the underlying NEAR/FAR Confidential Intents system; C is not a confidential balance on Aurora EVM. Funding uses `ORIGIN_CHAIN → CONFIDENTIAL_INTENTS`, with F as refund recipient. Distribution uses `CONFIDENTIAL_INTENTS → DESTINATION_CHAIN`, with each Ai as recipient and C as refund recipient. Explicitly select a supported non-public confidentiality mode. The detailed spec retains quote fields, payload envelopes, asset mapping and completion rules from the earlier research. A quote response or request acknowledgement is not evidence of recipient settlement.

Shielding and distribution are separately bounded operations by default. Each can involve multiple signatures after its initial unlock. If a future combined operation is approved, its native confirmation must include both phases and their complete limits. A signing session expiring during settlement requires a new unlock for further signatures; it does not require another deposit.

### 4.1 Step 3: shield the funded balance

1. Select the owned funding account, source chain, asset and amount. Persist the operation identity and account references before any spending step.
2. Establish the confidential account's identity and recovery mapping in native code. Verify the required key type, derivation and message format before implementing its signer. Existing EVM transfer support does not establish protocol-signature compatibility.
3. Obtain the protocol's deposit instructions and any applicable route. Validate destination, chain, asset, amount, fees, expiry and confidential beneficiary against the prepared operation.
4. Display the normalized operation in native UI and authenticate once. Sign only the approved deposit and any explicitly bounded approvals or protocol messages.
5. Persist the signed transaction or authorized request before sending it. Track submission and source confirmation separately from protocol credit.
6. Mark shielding complete only when the adapter can verify the expected confidential account was credited under the protocol's completion rules. Record credited amount, fees and any unresolved remainder.

The application may display the confidential balance to its user. Whether the operator or routing provider can see it is a separate privacy question to document. Public funding transactions still expose their public fields.

### 4.2 Step 4: distribute through Aurora Intent

1. Read the available confidential balance using the verified adapter. Accept the allocation algorithm's proposed amounts and wallet count.
2. Allocate and persist the owned recipient accounts natively. The demo's fixed six indices do not yet support arbitrary wallet counts; the derivation registry and backup format must be extended together.
3. Obtain route/quote information for the proposed recipients, destination chains and assets. Validate source debit, minimum destination receipts, fees, expiry and any refund/return destinations. Follow the existing specification’s quote and signed-spend request per allocation; bound execution concurrency and validate it against provider behavior.
4. Prepare one normalized distribution manifest covering the recipients and all debit/fee limits. Reserve the aggregate spend so concurrent or repeated requests cannot spend the same balance twice.
5. Display those limits in native UI and obtain a passkey authorization. Generate each protocol-specific signature natively only when its request matches the manifest and the session is valid.
6. Persist each request identity and authorization before submission. Record protocol acceptance and individual recipient settlement separately; an ambiguous timeout must not create another spend.
7. Reconcile partial completion, failures, unused balance and refunds. Confirm each destination receipt before marking its allocation complete, and mark the whole operation complete only after every allocation and remainder is accounted for.

Vault deposits and later withdrawals remain downstream integrations. Fresh return accounts must use persisted, newly allocated wallet indices; they do not require a new passkey. Contract methods, beneficiaries and return routes require their own native validation before they can use the signing session.

## 5. Authorization policy required by those flows

The prototype's fixed transfer policy would need extension to a versioned operation manifest containing at least:

- Operation ID, revision, action, creation time, authorization expiry and overall deadline.
- Owned funding/confidential account references and allocated recipient indices/addresses.
- Source and destination chains, assets and asset identifiers.
- Total source debit, per-recipient allocation, minimum receipts and explicit fee/slippage limits.
- Allowed protocol targets, contract methods, token spenders and allowance caps, where applicable.
- Quote/request identifiers, signed-message domain, nonce/replay protection and expiry required by the verified protocol.
- Refund/return recipients, step dependencies and completion conditions.

Native confirmation must render the same normalized data that execution checks. Bind authorization to that manifest's identity and revision; reject changes to recipients or increased spending authority until the user approves the revised operation. Quote refreshes may proceed only within already approved constraints and verified protocol rules.

Extend the journal to reserve, submit, reconcile and settle each allocation exactly once economically. The existing single-operation test engine is a starting point; it does not prove concurrent budget enforcement or idempotent protocol spending.

## 6. Persistence, recovery and outages

Preserve the existing rule: save the exact signed EVM transaction before broadcasting and reconcile its hash/nonce after an interruption. For confidential spending and intent requests, determine and persist the equivalent protocol identifiers, replay protections and status queries. Do not assume a new request is safe because the previous request timed out.

| Situation                                          | Required behavior                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App restart or expired session, local state intact | Restore allocations and progress, reconcile unknown outcomes and request another unlock before new signatures.                                                                                                               |
| Route expires before execution                     | Requote within the approved constraints or require revised approval; reconcile any prior submission first.                                                                                                                   |
| Some recipients settle and others remain pending   | Preserve completed allocations and resume only unresolved work after reconciliation.                                                                                                                                         |
| Wallet restored after device/data loss             | Recover or reconstruct confidential-account metadata, allocated indices, positions and pending spending state before enabling new spending. The prototype's entropy-only recovery payload is insufficient for this workflow. |
| Company backend unavailable                        | Wallet keys remain locally controlled. Document a usable alternative for any required provider credentials, discovery or orchestration; local signing alone does not supply it.                                              |
| Protocol, provider or chain unavailable            | Preserve pending state and show the unresolved dependency. Recovery cannot force an unavailable protocol to settle.                                                                                                          |

Extend encrypted recovery metadata with versioned derivation/role allocation, confidential identity and any required recovery secrets, plus the information needed to discover positions and reconcile outstanding operations. Define how stale backups catch up safely; restoring keys must not reset spent protocol nonces or silently replay an old distribution. Any sensitive payload stays native and encrypted outside the device.

A user-held encrypted file plus the original passkey is this prototype's recovery mechanism. Passkey sync alone cannot recreate independent wallet entropy. Independent recovery also needs a tested access path for RP/app continuity and protocol access; those requirements remain beyond the current test backup flow.

## 7. Privacy requirements

The wallet can derive different account addresses without publishing its common root or passkey. Preserve that property when integrating confidential balances and intents: verify what each authorization, recipient list and settlement record exposes publicly and to providers.

Shielding must be evaluated separately from splitting funds. Common gas funding, exact amounts, timing, public fan-out/fan-in, RPC logs, telemetry and later consolidation may correlate accounts. A confidential balance does not automatically hide destination payments or their association from a routing service.

The next research report must state who can observe the funding account, confidential account, balance, recipients and allocation mapping at each step: public chain observers, the app operator, routing providers and the user. Record findings from actual payloads and transactions rather than assuming unlinkability from distinct addresses.

## 8. Historical research deliverables and acceptance criteria

The signing module is the starting point for this phase. The proposed September work was to establish the concrete confidential-balance and Aurora Intent integration, then extend the combined prototype against that contract. This table is not a current mobile release checklist.

| Research deliverable                 | Required evidence                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated environment validation | Use the existing Aurora-only API design and Monad USDC → C → Ethereum USDC route target. Confirm project credentials, supported exact asset IDs, liquidity and current schema compatibility. Endpoint discovery is already recorded; funded execution is still unproven. |
| Native signer compatibility          | Exact key type, derivation, serialization, message domain and signature verification for every deposit/spending/intent action. Confirm any public linkage introduced by key registration.                                                                                |
| Shielding path                       | Trace a funded account through authorized submission to a verified credit in the intended confidential account, with amounts and fees reconciled.                                                                                                                        |
| Distribution path                    | Trace authorized confidential spending through Aurora routing to receipts in multiple owned accounts; reconcile totals, fees, remaining funds and refunds.                                                                                                               |
| Policy enforcement                   | Reject modified recipients, excess debits/fees/allowances, unsupported targets, expired requests, replay and concurrent overspending. Confirm secrets stay outside the RN bridge.                                                                                        |
| Interrupted execution                | Demonstrate expiry, termination, network loss, unknown submission outcomes and partial settlement without duplicate deposits or payouts.                                                                                                                                 |
| Recovery                             | Extend the backup for new accounts/protocol state and demonstrate second-device recovery and reconciliation, including a stale-backup case.                                                                                                                              |
| Privacy assessment                   | Capture public transaction fields and provider-visible request fields; identify links that remain visible.                                                                                                                                                               |

Keep existing signing and recovery behavior as regression requirements while adding adapters. Record device/OS/provider/build configuration, prompt counts, operation IDs and independently checked outcomes for new integration tests. A successful local transfer demo is not evidence that shielding or intent settlement works.

Production work still includes stable RP infrastructure, independently usable recovery, broader device/provider coverage, iOS implementation, dependency/release review and an appropriate security audit. The strict web secret-isolation requirement remains unresolved by this Android implementation.

## 9. Local implementation reference

| Artifact                                                                                                                                                                                                                                      | Use                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Combined prototype README](combined-wallet-prototype/README.md)                                                                                                                                                                              | Build instructions, current scope and recovery limitations.                   |
| [Native bridge contract](combined-wallet-prototype/specs/NativeWallet.ts)                                                                                                                                                                     | Existing public methods and returned operation/account views.                 |
| [Wallet engine](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/WalletEngine.kt)                                                                                                                               | Entropy creation, account/state persistence, sessions and transfer execution. |
| [Wallet Core signer](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/WalletCoreSigner.kt)                                                                                                                      | Actual derivation paths and restricted EVM signing support.                   |
| [Operation rules](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/OperationRules.kt)                                                                                                                           | Fixed batches and delayed-step authorization.                                 |
| [Passkey gate](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/PasskeyGate.kt) / [verifier](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/PasskeyVerifier.kt)                 | Registration/assertions, challenge binding and native verification.           |
| [Native recovery UI](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/RecoveryActivity.kt)                                                                                                                      | User confirmation and encrypted file import/export.                           |
| [Backup codec](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/RecoveryBackupCodec.kt) / [PRF protocol](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/RecoveryPrfProtocol.kt) | Versioned encrypted entropy backup and native PRF handling.                   |
| [Encrypted store](combined-wallet-prototype/android/app/src/main/java/com/walletsigningprototype/EncryptedWalletStore.kt)                                                                                                                     | Local AES-GCM/Keystore storage boundary.                                      |

Related protocol artifacts: [confidential balance and distribution specification, v0.10](outputs/confidential-balance-distribution-spec.md) and [Aurora signed-spending evidence](outputs/aurora-signed-spending-verification.md). The detailed specification records the historical proposed allocation, quote,
accounting, gas-readiness and settlement contract for this research stage. Current
mobile behavior is defined by the stored-signer source and the active internal
references linked above.
