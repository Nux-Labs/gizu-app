# Passkey and local development diagnostics

**Complexity: 2 — Technical.** Diagnose against the signed artifact and current source.
This documentation update did not test live hosting, signing artifacts or devices.
Use [setup guides](../app-guide/README.md) for the normal procedure.

## Separate the failure layers

| Symptom                            | Check next                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Wallet unavailable before a prompt | Native module, OS eligibility, foreground activity and release configuration |
| Passkey request rejected           | Signed app identity, hosted association and provider support                 |
| Passkey approved but access fails  | Native stage/error classification, local storage and lifecycle               |
| Backup/restore fails               | Original passkey, selected encrypted backup and native verification stage    |

A generic authorization error does not prove a website association problem.
Record build/version, platform, provider, operation and whether a prompt appeared.

## Signing and older installations

The canonical identity is [passkey-identity.json](../../mobile/src/config/passkey-identity.json).
Inspect the certificate on the actual installed/distributed APK; an upload key is
not evidence of the key Google Play uses to sign installed apps. Compare its public
SHA-256 with the package's hosted `assetlinks.json` entry.

Local debug signing uses `mobile/.credentials/android-debug.keystore`.
[The signing plugin](../../mobile/plugins/withAndroidDevelopmentSigning.cjs) points
Gradle outside the generated `android/` folder so prebuild does not replace the key.
If missing, intentionally provision a unique development key and authorize its
public fingerprint. Do not fall back to Expo's shared template key or replace a
release key to make a local build pass.

The legacy package `com.example.gizu.dev` has a different private storage area from
`io.gizu.android`; an existing ignored local Android project can still use it.
Installing a different package does not move the old wallet.
Keep an older installation until required recovery has been verified. The website
retains legacy app entries; their presence does not make them the current app identity.

## Website associations and Apple cache

Check HTTP status, content type and JSON body at the origin using the
[hosting guide](../app-guide/PASSKEY_HOSTING.md). A redirect or an HTML success page
is not a valid association. Check Apple's cached copy separately:

```sh
curl --fail-with-body -i https://app-site-association.cdn-apple.com/a/v1/gizu.io
```

Compare its `webcredentials.apps` with the source and origin. Apple caches these
files; a new IPA does not itself refresh the cache. Origin/CDN success still does
not prove the installed app's signing entitlement or device association state.
Inspect the signed app's `webcredentials:gizu.io` entitlement and application
identity before attributing the failure to the provider.

## Native diagnostics

For iOS, filter Console by subsystem `io.gizu.storedwallet`, category `ceremony`.
Use attempt ID, operation, stage and classified error to distinguish presentation,
verification, storage, backup and lifecycle failures. Rebuild to install native
logging changes. Do not include passkey credentials, secrets, backup contents or
raw sensitive provider responses in diagnostics.

The active wallet uses randomly generated entropy encrypted locally. Historical
PRF-derived address rules belong to the retired signer, not the current wallet.
See [native signer architecture](NATIVE_SIGNER.md) and
[dated verification evidence](NATIVE_SIGNER_VERIFICATION.md).

## Local development

- **Metro unreachable over USB:** check `adb devices` reports `device`, repeat
  port 8081 forwarding after reconnecting and start Metro with `--localhost`.
- **Local backend unreachable:** Metro forwarding does not forward backend traffic.
  Forward the backend's actual port separately and set `EXPO_PUBLIC_API_URL` to
  that forwarded localhost port. Restart Metro after changing the environment.
  Native hosted calls use `https://api.gizu.io` independently; Android's
  `-PgizuEarnBackend=usb` opts debug Earn gateway calls into port 3000 at build time,
  not every native request. Release builds ignore that USB selection.
- **Missing native module or stale binary:** rebuild the stored signer and app;
  reloading JavaScript cannot add native code. Expo Go cannot run this wallet.
- **Changed Expo config/plugin:** regenerate the affected native project before
  rebuilding. A clean prebuild replaces generated native files, so preserve any
  manual native edits first; keep `.credentials/` outside that directory.
- **Simulator passkeys fail:** inspect native diagnostics and provider capability.
  Do not add a simulated wallet fallback to make authentication appear successful.
