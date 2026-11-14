# Combined Android signing and recovery prototype

This retained standalone Android experiment is separate from the active Gizu app
in [`mobile/`](../../mobile/README.md). Its fixed-account policy, temporary RP domain
and file-only recovery describe this prototype. Current wallet implementation and
recovery are documented in [Native signer](../../docs/internal/NATIVE_SIGNER.md)
and [wallet discovery/recovery](../../docs/internal/WALLET_DISCOVERY_RECOVERY.md).

The prototype APK contains the original native 12-transfer wallet and native encrypted backup/restore screens. A fresh Android passkey assertion authorizes each operation. The six EVM account keys continue to derive from independent 32-byte wallet entropy; the passkey PRF wraps that existing entropy only when the user backs it up. No wallet entropy, PRF result, private key, or backup plaintext is returned to React Native JavaScript.

The fixed test operation sends six zero-wei and six one-wei self-transfers across six accounts on chain 31337. Its second batch starts at least 60 seconds after the first six confirm. The native engine saves signed raw transactions before submission and reconciles interrupted submissions by hash.

## Backup and restore

- **Back up wallet** opens a native screen, requires explicit confirmation and a new passkey assertion, then uses the passkey PRF output to AES-GCM encrypt the original wallet entropy and fixed six-account derivation metadata. Android's document picker asks where to save the encrypted JSON file.
- **Restore encrypted backup** appears when the wallet is absent or its local encrypted state cannot be opened. The user selects the file, authorizes with the original passkey, and the native engine reconstructs the same six addresses under a new local Android Keystore key.
- The file exposes only a format/version, passkey credential ID and public key, relying-party ID, and ciphertext. It contains no plaintext wallet addresses or wallet entropy.
- The user must retain the encrypted file and access to the synced passkey. Recovery on a second phone has **not** been tested. Restoration deliberately starts with an empty operation history; it does not resume an operation lost with the old device's local data.

## Rebuilding the standalone test

The Android application ID is `com.walletsigningprototype.combined`. It leaves both earlier test APKs installed separately. The prototype's configured relying-party ID, `transcript-development-roughly-correlation.trycloudflare.com`, is a temporary tunnel. The debug APK and enrolled passkey are disposable; durable recovery requires a stable HTTPS domain serving `/.well-known/assetlinks.json` for this package and its signing certificate.

The build requires Node.js 22.11.0 or newer (see `package.json`), JDK 17, Android SDK/NDK, and `npm ci`. Trust Wallet Core 4.8.3 comes from GitHub Packages, so put a read-only package token in local `android/local.properties` as `gpr.user` and `gpr.key`, or use `GITHUB_USER`/`GITHUB_TOKEN` environment variables. Never add those credentials to the source archive. The test `debug.keystore` private key is also excluded from the source archive; generate a new key and update Digital Asset Links when rebuilding elsewhere.

From `android`, run `./gradlew :app:testDebugUnitTest :app:assembleDemo`. The standalone APK is `android/app/build/outputs/apk/demo/app-demo.apk`. Run `npx tsc --noEmit` and `npm test -- --runInBand` from the app root.

For signing tests, start a disposable Ganache node on Mac port 8545 with chain ID 31337, connect the phone with USB debugging, and run `adb reverse tcp:8545 tcp:8545`. Fund the six public addresses shown by the app from the Ganache account. Test keys and the local chain must never hold real funds.

The native spending policy is enforced in software. This build does not claim hardware-enforced key access, production recovery, iOS support, or support for real vault adapters.
