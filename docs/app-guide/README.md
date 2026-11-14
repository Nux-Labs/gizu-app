# App setup and operation

**Complexity: 1 — Simple.** Use short, actionable steps and explain unfamiliar
terms. Keep only the detail needed to complete the task; link to internals and
detailed designs instead of embedding them here.

**Audience:** developers, testers and operators who need to run Gizu.

Use this folder for:

- Prerequisites, installation and environment configuration.
- Running the mobile app, frontend and backend locally.
- Simulator, physical-device and USB connection instructions.
- Builds, signing, distribution and release procedures.
- Deployment, routine service checks and operational runbooks.

State which platform and environment each procedure targets. Explain expected
results and link to deeper troubleshooting instead of embedding long investigations.
Clearly identify commands that deploy, publish or move real funds. Use placeholder
values for secrets and document where configuration belongs.

Implementation internals and investigations belong in
[Internal](../internal/README.md). Proposed work belongs in
[Feature plans](../feature-plans/README.md).

## Guides

Each guide follows prerequisites → steps → expected result → troubleshooting.

| Guide                                                   | Purpose                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Mobile local development](MOBILE_LOCAL_DEVELOPMENT.md) | Run iOS and Android development builds, including Android over USB.               |
| [Backend deployment](BACKEND_DEPLOYMENT.md)             | Shared runtime/provider configuration, release checks and legacy Render settings. |
| [AWS backend deployment](AWS_BACKEND_DEPLOYMENT.md)     | Build backend images from GitHub, configure ECS/RDS, and release manually.        |
| [Android signing](ANDROID_SIGNING.md)                   | Local Android signing and certificate association setup.                          |
| [Passkey configuration](PASSKEY_CONFIGURATION.md)       | App identity, relying-party domain and platform configuration.                    |
| [Passkey hosting](PASSKEY_HOSTING.md)                   | Publish canonical association files through the host serving the RP domain.       |

## Project entry points

- [Mobile README](../../mobile/README.md): local development, devices, builds and distribution.
- [Frontend README](../../frontend/README.md): web app and token discovery setup.
- [Repository README](../../README.md): repository overview and shared entry points.

Production API: `https://api.gizu.io`. Deployment guides describe repository
configuration and operator procedures; they do not establish live cloud, DNS,
signed-artifact or device state.
