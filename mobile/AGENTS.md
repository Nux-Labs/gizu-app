# Mobile engineering guidance

Applies to `mobile/` and its descendants. Keep this file focused on durable
engineering approaches; feature requirements and implementation history belong in docs.
Paths below are relative to `mobile/` unless stated otherwise.

## Stack and workspace

- Use Expo development builds, React Native, strict TypeScript, NativeWind and
  typed React Navigation. Use React hooks and scoped Context for local/app state.
- Use npm with the mobile-local lockfile. Keep dependencies, assets and scripts
  inside this app; verify native dependencies against the installed Expo SDK.
- Use package scripts as the command source of truth. Root `just` recipes should
  delegate to them and support Windows and macOS/Linux; identify platform-only steps.

## Architecture

- Organize features in `src/features/`. Screens compose UI; controller hooks own
  meaningful orchestration. Use typed view models when they simplify complex screens.
- Use `src/components/{atoms,molecules,organisms,templates}` for shared atomic UI:
  atoms are primitives, molecules are small groups, organisms compose sections,
  and templates own screen layout, safe areas, scrolling and keyboard handling.
- Keep business rules in `src/domain/`, typed service adapters in `src/services/`,
  persistence adapters in `src/storage/`, and app/provider composition in
  `src/application/`. Navigation belongs in `src/navigation/`.
- Keep native platform/cryptographic integration in `modules/`, app-facing adapters
  in `src/services/`, and pure wallet rules/contracts in `src/domain/`. Keep
  generated bindings separate from maintained source; regenerate rather than edit them.
- Shared UI receives data and callbacks; it does not fetch data, sign transactions
  or own feature rules. Imports flow toward reusable UI and domain/services, never
  from primitives back into features. Avoid cycles and pass-through abstractions.
- Keep one-off UI with its feature. Extract shared components for real reuse or
  stable primitives, not solely to satisfy the atomic taxonomy.

## State and service boundaries

- Separate UI, session and remote state. Give shared data one owner and clear
  account-scoped state and navigation history when the session changes.
- Isolate external APIs, wallet/signing providers and persistence behind typed,
  replaceable adapters. Keep mocks out of production paths; do not invent contracts
  or represent fixture behavior as live integration.
- Keep wallet secrets and signing approval inside the native boundary. JavaScript
  handles proposals and public results only; it must not bypass native authorization.
- Model loading, validation, rejection, failure and recovery explicitly. Prevent
  duplicate submissions and ignore stale results after cancellation or unmount.
  Closing UI does not imply cancellation of an external operation.
- Use decimal strings or base-unit integers with explicit precision and rounding
  for financial amounts. Validate inputs against agreed business constraints.
  Distinguish signing, submission and settlement; reconcile uncertain outcomes
  before retrying, using service-backed idempotency where supported.
- Gate protected routes and validate deep links. Keep credentials in appropriate
  secure storage; ordinary persistence is for non-sensitive data only. Never bundle
  or log secrets, signing keys or seed phrases.

## UI and native behavior

- Use shared semantic tokens and NativeWind for ordinary styling; use native styles
  for dynamic values and library requirements. Prefer existing primitives/variants.
- Use NativeWind breakpoint variants (`xs:`, `sm:`, `md:`, etc.) for responsive
  layout; do not use `useWindowDimensions` to select layout styles.
- Adapt the frontend's phone layouts to native interaction. Preserve agreed parity
  and mobile-specific decisions; do not import DOM or browser-only effects.
- Design for safe areas, keyboard access, large text, accessible roles/labels,
  clear disabled/error states and system reduced motion. Preserve native back and
  dismissal behavior; essential content must remain readable during animation.
- Use compatible native animation/SVG tools and verify asset/font redistribution
  rights. Validate changed native behavior on both platforms when available.

## Functional testing

- Use Jest, jest-expo and React Native Testing Library. Add functional coverage for
  meaningful new/changed journeys and regression tests for user-visible bugs that
  can be exercised at this layer.
- Render real screens with required navigation/providers. Exercise real controllers,
  validation and state transitions; mock only APIs, wallet/signing, persistence and
  unavailable native APIs. These tests use mocked services, not live backends/testnets.
- Interact as a user and query roles, labels or visible text. Assert visible results,
  action availability and navigation; inspect service calls for payload correctness
  or duplicate prevention, not internal hook state or component structure.
- Cover success and applicable validation, empty, loading, rejection, failure,
  cancellation and recovery paths. Use deterministic fixtures and reset state;
  avoid network calls, arbitrary sleeps and broad snapshot assertions.
- Place flows in `tests/functional/<feature>/*.functional.test.tsx`, grouped by
  primary user intent; shared helpers/fixtures go in `tests/support/`. Keep unit
  tests and adapter integration tests distinct.
- Run the full JavaScript/functional suite in PR CI; enforce coverage thresholds
  and native checks in release validation. Keep
  pre-commit checks scoped and fast. Rendered tests do not prove native gestures,
  biometrics or on-chain execution; report device checks separately.

## Workflow and verification

- Use LOR before substantive work with the repository root as workspace. Use
  Context7 for current library/API/setup guidance; reuse relevant loaded context.
- Run affected checks during development. From `mobile/`: `npm run test:functional`
  runs all flows; append `-- <file>` to focus. `npm run check` runs TypeScript,
  formatting, lint, Expo Doctor and coverage tests. Keep `just mobile-check` delegated
  to that npm command when workspace recipes are implemented.
- Match verification to the change: docs-only edits need formatting/link checks,
  not application tests. Report passed, failed, blocked and not-run checks accurately.
- Update the relevant docs when accepted decisions change. Add instructions here
  only when they apply repeatedly across features; remove obsolete or duplicate rules.

## Supporting context

Read only what the task needs:

- [README.md](README.md): local setup and available development commands.
- [PARITY.md](../docs/feature-plans/PARITY.md): current product decisions, frontend baseline,
  feature behavior and availability; consult when changing a user journey or design.
- [NATIVE_SIGNER.md](../docs/internal/NATIVE_SIGNER.md): native trust boundary, policy and
  derivation contract; consult before changing wallet/signing behavior.
