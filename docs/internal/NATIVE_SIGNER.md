# Native signer overview

**Complexity: 2 — Technical.** Start here to find the contract for a wallet task.

## Active implementation

`GizuStoredSigner` is the active native wallet module. Swift and Kotlin own platform
integration; the shared Rust core owns wallet and operation policies. JavaScript
requests operations and receives public results. Native code owns secret material,
passkey authorization and transaction approval.

- [Public TypeScript contract](../../mobile/src/domain/wallet/storedSigner.ts)
- [Native module and build instructions](../../mobile/modules/gizu-stored-signer/README.md)
- [Passkey setup](../app-guide/PASSKEY_CONFIGURATION.md) and
  [troubleshooting](PASSKEY_TROUBLESHOOTING.md)

## Topic references

| Reference                                               | Owns                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Architecture](NATIVE_SIGNER_ARCHITECTURE.md)           | Stored-wallet boundary, identity, derivation and session contract                 |
| [Portfolio and holdings](NATIVE_SIGNER_PORTFOLIO.md)    | Shared balance validation, platform reads, saved holdings and swap recovery       |
| [Storage and wallet recovery](NATIVE_SIGNER_STORAGE.md) | iOS authorization/storage, Android backup lifecycle and restore rules             |
| [Exact transfers](NATIVE_SIGNER_TRANSFERS.md)           | Testnet transfer policy, encrypted journals, reconciliation and explicit retries  |
| [Native Earn](NATIVE_SIGNER_EARN.md)                    | Earn authorization boundary, iOS integration and Android USB transport            |
| [Retired signer](NATIVE_SIGNER_RETIRED.md)              | Inactive module, former policy, dependency decisions and removed JavaScript probe |

Earn's feature behavior and rollout remain in [Confidential Earn](CONFIDENTIAL_EARN.md).
Detailed platform behavior stays with its owning topic; platform differences must
not be read as a claim of full parity.

## Status and evidence

The old `gizu-signer` module is disconnected; its reference is historical and must
not be used as the active API or as a fallback. The [migration record](SIGNER_MIGRATION.md)
preserves the transition decisions.

This index was split on 2026-10-08 and reviewed against source on 2026-11-14.
Historical evidence remains dated; this review adds no build or device acceptance.
Both native backup writers now emit version 3 and read versions 1–3; the TypeScript
identity constant still declares version 2. See the storage reference for codec and
platform limits rather than treating that constant as the file specification.
See [verification evidence](NATIVE_SIGNER_VERIFICATION.md) for recorded checks and gaps.
