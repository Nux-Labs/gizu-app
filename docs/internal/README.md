# Internal engineering documentation

**Complexity: 2 — Technical.** Assume basic development knowledge. Explain
components, boundaries, failure modes and evidence clearly. Put deeper design
alternatives, exhaustive contracts and implementation plans in `feature-plans/`.

**Audience:** engineers and maintainers debugging or inspecting Gizu.

Use this folder for:

- Debugging guides, diagnostic commands and log interpretation.
- Native, backend and provider implementation details.
- Operation lifecycles, persistence, recovery and failure analysis.
- Incident reports, investigations and dated verification evidence.

Record the affected component, source revision and verification date where useful.
Distinguish confirmed findings from hypotheses, and mocked tests from live results.
Redact sensitive data before saving evidence.

Routine setup and operation instructions belong in [App guide](../app-guide/README.md).
Proposed changes belong in [Feature plans](../feature-plans/README.md).

## Documents

### Debugging and verification

- [Swap failures](SWAP_FAILURES.md): phases, pause codes, logs and retry/reconciliation/approval decisions.

- [Passkey troubleshooting](PASSKEY_TROUBLESHOOTING.md): signing, associations, native diagnostics and local development failures.

- [Swap debugging](SWAP_DEBUGGING.md): device/backend setup, diagnostic layers and safe investigation.
- [Native signer verification](NATIVE_SIGNER_VERIFICATION.md): dated automated and device evidence.
- [Aurora signed-spending verification](../../research/outputs/aurora-signed-spending-verification.md): endpoint evidence and its limitations.
- [Swap transaction record](../../research/outputs/confidential-swap-tx-by-tx.md): the recorded mainnet AMZN run, transactions and visibility.

### Architecture and implementation references

- [Signer migration](SIGNER_MIGRATION.md): historical stored-wallet migration phases and acceptance criteria.

- [Backend runtime](BACKEND_RUNTIME.md): Anvil integrity, provider qualification, recovery and deployment evidence.

- [Native signer](NATIVE_SIGNER.md): short overview and topic index.
- [Signer architecture](NATIVE_SIGNER_ARCHITECTURE.md): active stored-wallet boundary and identity.
- [Portfolio and holdings](NATIVE_SIGNER_PORTFOLIO.md): shared validation and platform read/recovery behavior.
- [Signer storage](NATIVE_SIGNER_STORAGE.md): platform authorization, backup and restore.
- [Wallet discovery and recovery](WALLET_DISCOVERY_RECOVERY.md): private recovery sync, older backups, paged storage and Android rollout.
- [Exact transfers](NATIVE_SIGNER_TRANSFERS.md): testnet policy, journals and retries.
- [Native Earn](NATIVE_SIGNER_EARN.md): native authorization and platform transport.
- [Retired signer](NATIVE_SIGNER_RETIRED.md): inactive implementation and historical decisions.
- [Confidential Earn](CONFIDENTIAL_EARN.md): integration behavior and verification boundaries.
- [Confidential withdrawals](CONFIDENTIAL_WITHDRAWALS.md): private sale/vault proceeds, explicit distributed cashout, recovery and backend deployment.
- [Mobile foundation](FOUNDATION.md): runtime ownership and shared engineering conventions.
- [Infinite lists](INFINITE_LISTS.md): shared pagination and virtualized-list contracts.
- [Toast feedback](TOASTS.md): customization, accessibility and native-modal behavior.
- [Account and notifications](ACCOUNT.md): demo/local account implementation reference.
- [Trading and transfers](TRADING.md): demo transaction lifecycle and mock-service contracts.

The two research reports linked above remain in `research/outputs/`.

Current implementation prose was audited against repository source on
14 November 2026. Verification records, retired implementations and research
reports retain their original evidence dates; a documentation review is not a
new test, device acceptance or deployment. In particular, current Earn completion
does not use invite-only history, and Android private-read grants are separate
from spending approvals. Start with the Earn, withdrawal and storage references
above rather than applying historical migration instructions to an installed wallet.
