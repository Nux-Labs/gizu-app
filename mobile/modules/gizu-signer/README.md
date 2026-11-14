# Native signer ownership and structure

This is the retained, inactive native signing integration. It is excluded from
app autolinking on both platforms and is not a fallback. It is not a copied Mera SDK.
Compatibility with the frozen Mera derivation is covered by the reference vectors;
third-party cryptography is consumed through Cargo dependencies and Cargo.lock.
Credential Manager, AuthenticationServices and Expo supply platform integration.

## Source ownership

- `core/src/`: app-owned Rust derivation, operation policy and signing. Secret
  material stays here/native; this reorganization does not change the core.
- `android/src/main/java/io/gizu/signer/GizuSignerModule.kt`: Expo entry points
  and credential access.
- Android `rpc/`: network transport, response handling and progress reporting.
- Android `storage/`: journal persistence and reconciliation.
- Android `transfers/`: in-process handoff, native review/activity lifecycle and
  balance checks. Directory grouping retains the `io.gizu.signer` package so the
  manifest and module registration remain stable.
- `ios/GizuSignerModule.swift`: Expo entry points and credential access.
- iOS `RPC/`: network transport and RPC response validation.
- iOS `Storage/`: journal persistence and reconciliation.
- iOS `Transfers/`: native review/controller lifecycle and internal failure type.
- `scripts/`: binding/build commands and compatibility verification tools.
- `generated/`, `ios/Generated/`, `ios/GizuSignerCore.xcframework` and Android
  `jniLibs/`: generated artifacts. Regenerate with `npm run signer:build`; do not
  hand-edit them. Dependency implementation belongs in package caches, not here.

## JavaScript boundary

The app no longer looks up this module or launches its diagnostics. Its native
exports and source are preserved for deliberate future reuse. The replacement
contract lives separately in `src/domain/wallet/storedSigner.ts`.

Do not introduce PRF/key exports, arbitrary digest signing, or JavaScript approval.
Do not replace native policy with client validation. Retain write-before-broadcast,
unknown-result reconciliation, operation expiry, cancellation and sender binding.
Storage keys, journal schema, module names, derivation and native ABI were preserved.

## Independent verification and deliberate reactivation

From `mobile/`, `npm run signer:test` tests this Rust core and
`npm run signer:build -- android` (or `ios` on macOS) builds its native artifacts.
These commands do not reconnect it to the app. Source, tests and bindings remain
here; the app native build jobs do not compile or link this module. The
`native-core` job in `.github/workflows/mobile-release.yml` still runs its Rust
format, test and Clippy checks alongside the stored signer. Workflow presence
is not a claim of a newly passing hosted run.

Platform wrapper tests need an isolated Expo host with this local module linked.
In that host, run `:gizu-signer:testDebugUnitTest` for Android and the usual iOS
pod/build steps. The disconnected application cannot run that Gradle task.

To reactivate deliberately, review the preserved identity/policy, remove the
`gizu-signer` autolinking exclusion in an isolated host, wire its explicit adapter
and rebuild the native client. Never enable it as an automatic fallback or merely
change a runtime environment variable. Check native registration and repeat device
acceptance before use. A Metro reload cannot add or remove the native module.
