# Host passkey associations

Publish the files that allow Gizu's signed apps to use passkeys on `gizu.io`.
Their canonical source is `frontend/public/.well-known/`; the deployment serving
the RP domain must publish them even when that domain serves `landing/`.

## Prerequisites

- Access to the website hosting service serving `gizu.io`.
- [Confirmed app identities](PASSKEY_CONFIGURATION.md) and
  [Android signing certificates](ANDROID_SIGNING.md).
- Identify the active host before publishing. Repository workflows do not establish
  current AWS provisioning, release enablement or DNS routing.

## Steps

1. Check the source files. Preserve approved entries for existing installations:
   - [Apple association](../../frontend/public/.well-known/apple-app-site-association)
     must include `588X2UZY3L.io.gizo.ios` under `webcredentials.apps`.
   - [Android association](../../frontend/public/.well-known/assetlinks.json)
     must include the installed APK's package and public signing certificate.
     Canonical builds use `io.gizu.android`; legacy entries remain for older installs.
2. Package for the host you actually operate:
   - **Landing S3/CloudFront delivery:** use the
     [landing deployment procedure](../../deploy/landing/README.md). Its packager
     copies the canonical JSON byte-for-byte without building the frontend.
     Automatic publication rejects changes to associations relative to the current
     archive; association updates need a reviewed rollout that preserves installed
     app compatibility.
   - **A host serving the frontend build:** run the following from the repository
     root and check both files exist in `frontend/dist/.well-known/`:

     ```sh
     npm --prefix frontend ci
     npm --prefix frontend run build
     ```
3. Publish through the active host's release procedure. Serve both paths directly
   over HTTPS, without redirects or an HTML fallback, with these response headers:

   | Path                                      | Header         | Value              |
   | ----------------------------------------- | -------------- | ------------------ |
   | `/.well-known/apple-app-site-association` | `Content-Type` | `application/json` |
   | `/.well-known/assetlinks.json`            | `Content-Type` | `application/json` |

   Serving associations only at `app.gizu.io` does not satisfy the `gizu.io` RP ID.

4. Check the deployed responses without following redirects:

   ```sh
   curl --fail-with-body -i https://gizu.io/.well-known/apple-app-site-association
   curl --fail-with-body -i https://gizu.io/.well-known/assetlinks.json
   ```

## Expected result

Both URLs return HTTP 200 and JSON matching the intended source associations.
These HTTP checks confirm hosting only; test passkey access in the signed app too.

## Troubleshooting

See [association and Apple cache diagnostics](../internal/PASSKEY_TROUBLESHOOTING.md).
