# Passkey configuration

Use this guide when checking the app identity before a native build.

## Prerequisites

- A native Gizu build; Expo Go does not include the wallet module.
- iOS 18+ or Android 9+ with a compatible passkey provider.
- Access to the app's signing configuration and the website serving `gizu.io`.

## Steps

1. Check [the shared identity file](../../mobile/src/config/passkey-identity.json).
   The current values are:

   | Setting                | Value             |
   | ---------------------- | ----------------- |
   | Passkey domain (RP ID) | `gizu.io`         |
   | App name               | `Gizu`            |
   | Apple team             | `588X2UZY3L`      |
   | iOS bundle ID          | `io.gizo.ios`     |
   | Android package        | `io.gizu.android` |

   The `gizo` spelling in the iOS bundle ID is intentional. Do not rename it
   to match Android. Development and release builds share the passkey domain.
   These are the canonical build identities; an existing ignored Android project
   may retain the legacy package described in [Android signing](ANDROID_SIGNING.md).
   Check the signed artifact rather than assuming prebuild updated it.

2. Check [Expo configuration](../../mobile/app.config.ts) uses that identity.
   iOS must include `webcredentials:gizu.io` in Associated Domains and be signed
   with that capability. For Android, follow [Android signing](ANDROID_SIGNING.md).
3. [Deploy the matching website associations](PASSKEY_HOSTING.md) if they changed.
4. Rebuild the native app after identity, entitlement or native-module changes.
   Follow [local development](MOBILE_LOCAL_DEVELOPMENT.md).
5. Open the app and test passkey access. The launch scripts select `native`, the
   only supported passkey mode. OS version alone does not prove provider support.

## Expected result

The signed app and website authorize the same identity. A supported device can
create or open a wallet through the native passkey flow. Test backup/restore
separately before relying on it for recovery.

## Troubleshooting

See [passkey diagnostics](../internal/PASSKEY_TROUBLESHOOTING.md).
For wallet storage and authorization design, see
[the native signer](../internal/NATIVE_SIGNER.md).
