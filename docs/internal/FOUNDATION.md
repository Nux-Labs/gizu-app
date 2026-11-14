# Mobile foundation

Current source baseline checked 2026-11-14; documentation-only source review. This reference describes the runtime. Historical milestone diaries
remain in Git. Native evidence is summarized in
[signer verification](NATIVE_SIGNER_VERIFICATION.md).

## Runtime and ownership

- Expo ~57.0.31, React Native 0.86.3, React 19.2.3; New Architecture and Hermes.
- NativeWind 4.2.7 / Tailwind 3.4.17, React Navigation 7 (no Expo Router),
  Reanimated 4.5.1 / Worklets 0.10.1, SVG, safe areas and native screens.
- npm-local lockfile; Node 24 / npm 11 constraints are declared in package.json.
- Strict TypeScript, ESLint, Prettier, Jest/jest-expo/RNTL and coverage thresholds.
- Exact dependencies and scripts: `package.json` / `package-lock.json`. Do not
  duplicate full version tables here or bypass peer conflicts with force flags.
- Features own screens/controllers; shared atomic UI, domain rules, service adapters,
  application composition and navigation have separate owners. Native integration
  lives in `modules/`; generated bindings are regenerated, never hand-edited.

## Platforms and presentation

Expo baseline is distinct from passkey capability: native signer requires iOS 18+
and Android API 28+ with a PRF-capable provider. OS eligibility alone does not
establish provider compatibility. Check installed build configuration before
changing platform floors. Local iOS builds require macOS/Xcode. The root justfile
provides `sh` and Windows `cmd.exe` recipes; JavaScript release validation includes
Windows, while native signer scripts require macOS/Linux.

iOS uses Helvetica Neue. Android bundles the owner-licensed HelveticaNeue family
through the Expo font plugin; small monospace labels use the system font. Use shared semantic tokens, safe areas, accessible controls, text scaling
and reduced motion. Portrait-first/no dedicated tablet layout remains provisional.
Current product behavior is owned by [PARITY](../feature-plans/PARITY.md), not historical phases.

## Identity and release boundary

Development identity and domain association setup live in
[passkey configuration](../app-guide/PASSKEY_CONFIGURATION.md) and
[Android signing](../app-guide/ANDROID_SIGNING.md). Do not treat development placeholders,
shared RP or a successful local probe as production release approval.
Production identity, EAS ownership and build/submission profiles are configured in
`mobile/app.config.ts` and `mobile/eas.json`; TestFlight is an alias of production.
Configuration does not establish signed distribution, physical-device acceptance,
independent recovery or security-review completion. Never silently connect fixture investments
to a real native signer.

## Recorded verification limits

Mobile functional checks validate rendered behavior with external services mocked.
They do not prove native biometrics, signing isolation or network settlement.
The old Expo Doctor 57.0.24/57.0.25 mismatch describes a historical build; the
current package declares ~57.0.31. Doctor was not rerun during this docs review.
UI milestone tests/builds were recorded during development; small-display,
accessibility, Windows and full signed-device acceptance were incomplete.
See the signer verification record for exact retained native/live evidence and
README for commands. No application/native checks were rerun by this documentation review.
