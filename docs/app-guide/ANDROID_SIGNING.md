# Android signing

Use this guide to associate an Android build with passkeys on `gizu.io`.
The canonical app package is `io.gizu.android`. Existing ignored native projects
can retain the legacy `com.example.gizu.dev` package; inspect the APK you will
install and preserve an existing wallet installation's package and certificate.

## Prerequisites

- JDK 17 with `keytool` available.
- The signing certificate for the build you will install.
- Access to the website deployment serving `gizu.io` if a new certificate must be authorized.

## Steps

1. Choose the certificate for your installation:

   | Installation       | Certificate to use                                  |
   | ------------------ | --------------------------------------------------- |
   | Local debug build  | Persistent local development key                    |
   | Direct release APK | Key that signed that APK                            |
   | Google Play        | **App signing key certificate**, not the upload key |

2. For local development, inspect the existing key from the repository root:

   ```sh
   keytool -list -v -keystore mobile/.credentials/android-debug.keystore \
     -alias androiddebugkey -storepass android
   ```

   Keep this private file out of Git. If it is missing, establish a deliberate
   development signing setup before building; do not substitute a shared debug key.

3. Compare the public SHA-256 fingerprint with the approved fingerprints in
   [mobile identity](../../mobile/src/config/passkey-identity.json) and the
   entry for the APK's actual package in
   [assetlinks.json](../../frontend/public/.well-known/assetlinks.json).
   Add an approved missing fingerprint to both; preserve existing entries.
4. If the association changed, [deploy and verify it](PASSKEY_HOSTING.md).
5. [Build and install the app](MOBILE_LOCAL_DEVELOPMENT.md), then test passkey
   access on that installation. Keep the private keystore on your machine.

## Expected result

The installed app's package and signing certificate match the hosted association,
and a compatible device can show the passkey prompt. A successful build alone
is not a passkey test.

## Troubleshooting

See [signing and passkey diagnostics](../internal/PASSKEY_TROUBLESHOOTING.md)
for certificate mismatches, missing local keys and older installations.
