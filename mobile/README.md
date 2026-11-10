# Gizu mobile

Expo SDK 57 development app for iOS and Android. Normal startup now uses native
passkey access and the existing Gizu tabs. Home shows the native Circle USDC portfolio
across public Monad mainnet accounts (143); Account shows the receiving address,
copy, local preferences and disconnect.
Wallet secrets remain in the native signer. This is local wallet access, not
backend authentication; physical-iOS acceptance remains pending.

From welcome choose **Get started**, then **Continue with passkey**. New development
wallets must save and reopen an encrypted backup before Home opens. Recovery needs
the file and original passkey. Notifications, fiat valuations and performance history
remain unavailable. Deposit shows the Monad mainnet USDC receiving address.
Direct standalone USDC withdrawals remain unavailable. Earn can review a separate
withdrawal of verified investment return credit to a native Monad receiving account. Confidential Earn
prepares two native-owned wallets after intent, reads vault readiness and private
balances, and executes independently reviewed native funding, payouts and investments. See [Confidential Earn](../docs/internal/CONFIDENTIAL_EARN.md).
iOS 18+ stored-wallet support is implemented; physical-device acceptance is pending. Incoming/external activity is not indexed.

Normal startup supports native access only. Historical M2–M5 fixture flows remain
in automated tests; the isolated UI playground retains visual fixtures.

## Prerequisites

- Node 24.15.0 and npm 11.12.1 (npm is the package manager).
- Optional workspace shortcuts: just **1.40.0** on PATH. The root justfile uses
  `sh` on macOS/Linux and `cmd.exe` on Windows. No Bash is required on Windows.
- Android: Android Studio, SDK/platform tools, an emulator or USB device and
  JDK 17. Configure `ANDROID_HOME` and `JAVA_HOME` for your installation.
- iOS: macOS, Xcode 26.4+ with an installed iOS simulator runtime, Xcode command-line
  tools and CocoaPods. Physical devices require Apple signing setup.
- Use a development build, not Expo Go, for native validation.

## Install and run

From the repository root:

```sh
npm --prefix mobile ci
# Generate native Rust libraries and bindings before the first Android build:
npm --prefix mobile run stored-signer:build -- android
npm --prefix mobile run android -- --no-bundler
# macOS only (requires Rust 1.94.1 and Apple Rust targets):
npm --prefix mobile run stored-signer:build:ios
npm --prefix mobile run ios -- --no-bundler
```

These commands generate ignored native projects and build/install a development
client. After that, start Metro with `npm --prefix mobile start` and open the
installed development app. Rebuild after native dependency/config changes.
`just mobile-install`, `just mobile-android`, `just mobile-ios` and
`just mobile-start` are equivalent shortcuts.

App identity: **Gizu**, iOS `io.gizo.ios`, Android `io.gizu.android`,
URL scheme `gizu`. The Android package is retained for installation and wallet
storage continuity; changing it requires an explicit migration. Both platforms
use `gizu.io` as their passkey relying-party domain.

## Android without a laptop or Metro

A development APK needs Metro for its JavaScript. A locally built release APK
embeds JavaScript and assets, so it opens from the phone's Gizu icon after USB is
disconnected. Internet access is still required for Render and chain providers.

After the native Android project and signer libraries have been generated, build
from `mobile/android/` on this Mac:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@17 \
NODE_ENV=production \
GIZU_BUILD_VARIANT=production \
EXPO_PUBLIC_API_URL=https://api.gizu.io \
EXPO_PUBLIC_PASSKEY_MODE=native \
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Use Node 24 on PATH. This arm64 APK matches the connected Samsung phone. Install
`mobile/android/app/build/outputs/apk/release/app-release.apk` with
`adb install -r <path-to-apk>`, then open Gizu from the phone's app list. USB is only
needed for installation. Mobile source changes require rebuilding/reinstalling;
backend catalog/environment changes require a Render deployment and app refresh.

For this existing test installation, retain its Android application ID and signing
keystore when updating. Its generated project uses `com.example.gizu.dev`, while
new projects use `io.gizu.android`. Re-running prebuild can replace that local
identity. Never uninstall to resolve a signing mismatch: installation identity
also determines access to the encrypted wallet storage. The local release uses
the existing development signing key for testing; store distribution has separate
signing requirements.

## Commands

Passkey identity and manual domain checks are documented in
[PASSKEY_CONFIGURATION.md](../docs/app-guide/PASSKEY_CONFIGURATION.md). The frontend owns the
hosted association files; deployment does not happen from mobile scripts.
The [former P1 probe](../docs/internal/NATIVE_SIGNER_RETIRED.md#retired-javascript-probe) has been removed. Native mode uses
the native signer; raw PRF is never exposed to JavaScript. Rebuild older clients
to remove the old bridge and install the current signer.

Run inside `mobile/`, or use `npm --prefix mobile` from the root.

| Command                                                                                          | Scope                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `npm run typecheck`                                                                              | Strict TypeScript, including tests/config                      |
| `npm run lint`                                                                                   | Expo ESLint plus atom import boundaries; no warnings           |
| `npm run format:check`                                                                           | Non-mutating Prettier check                                    |
| `npm run format`                                                                                 | Explicit formatting write                                      |
| `npm test`                                                                                       | All unit and functional tests                                  |
| `npm run test:functional`                                                                        | Full screen-flow suite                                         |
| `npm run test:functional -- --runTestsByPath tests/functional/access/access.functional.test.tsx` | Focused journey                                                |
| `npm run test:coverage`                                                                          | All tests and full-source coverage thresholds                  |
| `npm run doctor`                                                                                 | Expo project and dependency health; network access required    |
| `npm run check`                                                                                  | Typecheck, formatting, lint, Doctor and complete test coverage |
| `npm run export`                                                                                 | Compile iOS/Android JS and bundled assets; not a native build  |
| `npm run prebuild -- --no-install`                                                               | Generate ignored iOS/Android projects                          |
| `npm run hooks:install`                                                                          | Opt-in repository hook setup; refuses to replace other hooks   |
| `npm run precommit`                                                                              | Check changed mobile files without rewriting them              |

`npm run format:kotlin` formats maintained stored-signer Kotlin (including tests).
`npm run format:kotlin:check` checks it without rewriting and runs in Android CI.
Both require JDK 17 (`JAVA_HOME` or Java on PATH); the first run downloads the
checksum-pinned ktfmt 0.54 JAR into the OS temporary cache. Generated bindings and
the disconnected legacy signer are excluded. Kotlin uses ktfmt's Google style.

`just mobile-check` delegates to `npm run check`. Release validation runs it on Linux
and Windows, then separately compiles Android Debug and an unsigned iOS simulator
build. PR CI runs typecheck, formatting, lint and all JavaScript tests on Linux,
without coverage or Expo Doctor. See the [repository CI guide](../README.md#continuous-integration)
for manual release validation and required-check settings.
Configure these jobs as required branch checks in repository settings to enforce
merge protection; the workflow alone cannot change branch protection.

Pre-commit checks formatting/lint for staged paths using working-tree contents;
CI checks the committed revision. Run affected tests during development. Installing
hooks is explicit because this repository contains independently managed apps.
Husky on Windows requires Git for Windows (including its `sh`).
Formatting: two spaces, semicolons, double quotes, 100-column width, LF endings.

## Structure and testing

`src/application` composes startup/providers; `src/navigation` owns typed routes;
`src/features` owns screens; `src/components/atoms` and `templates` hold reusable UI.
Add molecules/organisms when meaningful reuse exists. Colors have one source in
`src/theme/colors.json`, consumed by Tailwind and native navigation.

Functional tests render real screens, navigation and session/controller logic.
Services are injected to test loading, rejection, failure, retry and cancellation;
unavailable native animation/linking boundaries are mocked. Tests also cover cold
and runtime protected deep links, modal cancellation, tabs and disconnect. Unit
tests cover render-error recovery and disabled actions.
Follow [AGENTS.md](AGENTS.md) for permanent testing and architecture policy.
Initial coverage floors are 80% statements/functions/lines and 70% branches,
based on this small foundation's measured coverage; include all source files and
raise floors as the app grows. These tests do not verify native gestures, keyboard
presentation, real biometrics, network operations or on-chain settlement.

See [docs/FOUNDATION.md](../docs/internal/FOUNDATION.md) for version decisions and the validation
record, and [docs/PARITY.md](../docs/feature-plans/PARITY.md) for the frozen product scope.

## Portfolio and vaults

All M3 values come from mobile-local typed mock adapters. Portfolio totals sum
integer cents; chart samples are synthetic performance indexes, never trade prices.
Period buttons select deterministic 1D/1W/1M/1Y/All fixture windows. Search combines
case-insensitive name/ticker/strategy/manager matching with the selected risk band.
Advanced filters are explicitly unavailable. Vault sharing opens the native share
sheet with a labeled demo summary and no fabricated public URL.

Refresh preserves the previous snapshot on failure and labels stale/offline data.
An empty portfolio, missing vault and empty activity have explicit states. Service
adapters can inject those states in tests; no real network or OS connectivity is
inferred. Disconnect clears the snapshot and invalidates pending requests.

Home shows the vault-summary discovery list only when the account has no holdings.
Accounts with holdings see their holdings list without the duplicate vault summaries;
the full discovery catalog remains available from the Vaults tab.

Notifications, buy/sell and deposit/withdraw are identified by availability notes.
They do not simulate a successful operation.

Balance and vault price lead their screens; demo disclosure remains visible while
its timestamp expands on tap. Refresh uses a quiet action. Search/risk filters sit
near the top and Clear filters appears only when needed. Content Back preserves the
previous screen and falls back to the relevant tab for direct entry. Settings →
UI preview demonstrates shared actions, metrics, filters and feedback states.

The iPhone 17 Pro / iOS 26.5 development app was inspected at standard and enlarged
text sizes, including native sharing and software keyboard search. Smaller native
displays, VoiceOver, reduced motion, gestures and Android QA remain pending; see
the foundation record for the exact scope.

All top navigator bars are hidden, including access and modal screens. Each screen
owns its content title; detail/access screens provide a scrolling Back action and
the wallet picker retains Cancel. Bottom tabs remain available on main screens.
The shared Screen template applies safe-area insets and keyboard spacing directly.

## Frontend design parity (M3.2)

The interface now uses layered rounded surfaces, compact vault tiles with sparklines,
change badges, grouped holdings/terms/account rows, paired access cards and a floating
bottom-tab capsule. All top navigation bars remain hidden. The capsule floats over a
transparent overlay, with its measured height reserved in scroll-content bottom padding
so the last items can scroll clear of it. Narrow/large-text vault layouts use one column.

User-facing demo banners and prefixes are removed. The app still uses isolated mock
services and memory-only sessions; this visual update adds no live wallet, signing,
market feed or backend. Share payloads retain fixture provenance. M4 enables mock
trading/transfers; M5 adds account pages, preferences and the in-app inbox. Timestamp details,
error/retry and stale/offline feedback remain available.

System fonts are used because no mobile redistribution licence was found for the
frontend Helvetica assets. Decorative artwork is static and supports reduced motion.
See docs/FOUNDATION.md for the exact native and automated validation record.

## Latest frontend reconciliation (M3.3)

Welcome now uses the Gizu logo and “DeFi in Stealth Mode” headline. Portfolio and
vault discovery use “Confidential vaults”; the Swap tab shows the animated coming-soon
presentation. Vault details provide buy/sell through M4 mock services. Access supports
passkeys only.

Request access opens a guest form with email, investment range and platform choices.
Its isolated mock service sends and stores nothing and does not grant access or
create a real waitlist entry. Functional tests cover validation, submission, retry,
duplicate prevention and dismissal. Notifications use the M5 mock inbox.

## Trading and transfers (M4)

Home opens Deposit/Withdraw; vault details open Buy/Sell. The Swap tab remains a
coming-soon presentation. Every available operation requires amount validation and quote review. After
submission, Check status reconciles the same operation; closing the modal does
not cancel it. Home and Activity can reopen status. The session-scoped mock ledger
updates cash, units and activity only on confirmed responses and resets at sign-out.

See [docs/TRADING.md](../docs/internal/TRADING.md) for exact fee, minimum, lockup, rounding,
scenario and dismissal rules. These interfaces are mock contracts, not production
API specifications or real wallet/signing integrations.

## Account and notifications (M5)

Home's notification button opens the inbox with read/unread and mark-all controls.
Account opens passkey/signing information, push-alert preferences, currency,
statements, contact desk and disclosures. Copy address uses the native clipboard.
Only non-sensitive preferences persist in AsyncStorage; explicit disconnect clears
this account's preferences and all session state. USD is the only supported display
currency. Recovery, push delivery, FX, document downloads and support channels are
explicitly unavailable pending their integrations. Real passkeys are next.

See [docs/ACCOUNT.md](../docs/internal/ACCOUNT.md) for availability and persistence rules.
M5 adds native storage/clipboard modules: rebuild an existing development client
with `npm run ios` or `npm run android` from `mobile/` before testing this version.

## Signer migration and developer diagnostics

The old Gizu signer is preserved but disconnected from app access, diagnostics and
native autolinking. `npm start` opens the existing app. Android and iOS 18+ development wallets
require native save-and-reopen backup verification before entering Home. Account
includes backup management; Withdraw and Activity use native approval and history. iOS signing uses the replacement Swift module; physical-device acceptance is pending. No fallback creates a demo or legacy wallet.

The isolated UI playground remains available without a simulated passkey mode:

    npm run debug:ui -- --port 8087

Legacy wallet/signer harness source remains for reference, but its launch commands
and native lookups are disconnected. Old debug selections fail explicitly.

Rebuild installed clients with `npm run android` or `npm run ios` to remove the
old native module; restarting Metro alone cannot remove native registrations.
Independent retained-core build/test commands remain `npm run signer:build` and
`npm run signer:test`; see the [retained module guide](modules/gizu-signer/README.md).
Follow the [migration plan](../docs/internal/SIGNER_MIGRATION.md) for the replacement contract
and remaining implementation.

## Wallet integration organization

Wallet adapters are grouped in `src/services/wallet/`; pure amounts, proposals and
public contracts live in `src/domain/wallet/`. Features depend on those interfaces,
not generated cryptographic bindings. The replacement contract is
`src/domain/wallet/storedSigner.ts`; the legacy module stays independently retained.

Replacement module verification uses `npm run stored-signer:test` and
`npm run stored-signer:build`; see its [module guide](modules/gizu-stored-signer/README.md).

For Android testing, rebuild with `npm run android`, then use the normal
app (`npm start`). Continue with passkey, save the encrypted backup, reopen it and
confirm the original passkey again. Only successful verification opens Home.
Cancel before verification and retry: the same wallet must resume backup setup.
Account offers **Save and verify wallet backup**. Recovery requires both the backup
file and original passkey. Restore is shown only for absent/unreadable local storage;
use another installation/device to test it without deleting this wallet.

The following historical checks apply to the isolated testnet transfer diagnostic,
not the normal mainnet USDC Home. In that diagnostic, fund Account 0 with testnet MON only
and use its transfer action for a small transfer. Read the native review, approve and unlock
with the wallet's passkey. Activity **Refresh** only reconciles; **Review and resume**
requires a new native review/passkey prompt. Cancel stops unsigned remaining steps;
it cannot undo signed/submitted transfers. Pending or nonce-conflicting operations
block new transfers. Restoring a backup does not restore local transaction history.

Phase-3 guided checks were user-reported successful. Guided phase-4 cancellation, withdrawal, restart and resume checks were also
user-reported successful. Extended failure paths and second-device restore remain pending. Test restore only where the original
passkey is available and compare Account 0. The explicit `npm run debug:stored-wallet`
harness and retained legacy source remain separate from normal entry.

## Local vault catalog

Normal wallet mode reads the backend's `GET /v1/chains` and combines opportunities
from all configured chains without a chain selector. The environment example uses
`VAULT_CHAINS=1,4663,143` for Ethereum, Robinhood and Monad. Set `VAULT_CHAINS` and optional
`CATALOG_CHAINS_JSON` metadata / `CATALOG_VAULTS_JSON` contracts on
the backend; see [catalog configuration](../docs/app-guide/BACKEND_DEPLOYMENT.md#vault-catalog-configuration)
for contracts on any enabled chain and fallback metadata. The default pinned
profiles are Pendle USDC on Ethereum and Steakhouse USDG on Robinhood.
`CATALOG_VAULTS_JSON` adds featured promotions alongside these profiles; omitted or
`[]` disables promotions only. The example features Gizu Prime AUSD on Monad
(`0x997D5064A7B48305c15C9D55AC2D94D7069Fc008`). Duplicate chain/contract pairs merge
into one card. Promotions on disabled chains remain hidden.
Protocol filter options come from the catalog's `facets.protocols`; the filter is hidden
when fewer than two protocols are listed. Search, paging and retry controls share one screen.
Paging tracks each chain independently and stops querying exhausted chains.
Details show contract addresses and share symbols; unknown metrics show `Unavailable`,
and Morpho net APY is labeled as APY. Protocol logos resolve by
stable protocol ID before display name. Wallet balances still use Monad mainnet USDC.
Deposit stays inside Gizu and rechecks the selected vault. An exact match to an
existing Ethereum/Robinhood native profile prepares a fresh Earn cycle only after
explicit intent, then reuses the existing funding and fee reviews. Unsupported
ordinary vaults are excluded from lists and details. Explicit promotions remain
visible with a Featured label; unsupported promotions have informational details
without deposit/withdraw actions or a deposit amount calculator. Monad/AUSD execution is not implemented
in this catalog change. Catalog metadata cannot grant signing authority.
Fixture vaults remain in tests and the isolated UI playground.

Start PostgreSQL with `docker compose up -d` in `backend/`. Set the backend local
`DATABASE_URL` to match `backend/.env.example` (port 54329), then run `npm run build`
and `npm start`. `GET http://127.0.0.1:3000/v1/health` should return status `ok`.

Development mobile defaults to `http://127.0.0.1:3000`. With an Android phone connected
by USB, run `adb reverse tcp:3000 tcp:3000` in addition to the Metro port forwarding.
For other hosts, set `EXPO_PUBLIC_API_URL` to a reachable backend URL and restart Metro.
Release builds require an explicit HTTPS URL. The public configuration contains no
provider API keys; those stay on the backend.

### iOS stored-wallet development

Install Rust 1.94.1 targets `aarch64-apple-ios` and `aarch64-apple-ios-sim`, then run
`npm run stored-signer:build:ios` from `mobile/`. Rebuild with `npm run ios`; Expo Go
cannot load the signer. The config plugin sets the app deployment target to iOS 18.
The existing Team ID, bundle ID and `webcredentials:gizu.io` association are retained;
physical builds still require working signing and domain association.

`npm run stored-signer:test:ios` runs native simulator tests. Use
`GIZU_IOS_TEST_DEVICE=<simulator UDID>` to select a simulator.
`npm run stored-signer:check:ios` checks generated native registration after pod install.
These checks do not prove real passkey, Keychain, Files-provider or iPhone recovery
behavior; no simulator authentication bypass is included.

## Production builds and TestFlight distribution

The `production` EAS profile builds **Gizu** with the production EAS environment
and `https://api.gizu.io` backend. iOS uses bundle ID `io.gizo.ios`,
Apple team `588X2UZY3L` and App Store Connect app `6815255408`.
`testflight` remains a compatibility alias of `production`, not a separate app.
`preview` inherits the same configuration for internal distribution.
All profiles use the Gizu name and `gizu` URL scheme. Development builds can still
use diagnostic screens; release configuration rejects those entry points.

`GizuWalletEnabled` is embedded in the signed iOS release binary. It enables
wallet access without changing native transaction policy. Mainnet UI and flows
remain as implemented; release naming does not establish platform feature parity
or complete the outstanding physical-iPhone acceptance.

The sole passkey domain is `gizu.io`. Deploy the association file and verify both
the origin and Apple's cache authorize `588X2UZY3L.io.gizo.ios`; see
[hosting instructions](../docs/app-guide/PASSKEY_HOSTING.md). Existing development
association entries are retained for older installations, not additional domains.

From `mobile/`, increment `ios.buildNumber` before a new upload, then build locally:

```sh
EXPO_NO_DOTENV=1 npx eas-cli build --platform ios --profile production --local --output ./gizu.ipa
```

For Android, increment `android.versionCode` before each subsequent Play upload
and keep the registered upload keystore. The first bundle uses version code 1.
From `mobile/`, with JDK 17, Android SDK/NDK and Rust prerequisites installed:

```sh
EXPO_NO_DOTENV=1 npx eas-cli build --platform android --profile production --local --output ./gizu.aab
```

The pre-install hook generates the stored signer's Rust library and bindings in
the EAS build workspace on both platforms. Android release profiles target
`arm64-v8a`, the architecture currently supported by the native signer, and link
its Rust library with 16 KB page alignment. Upload the signed AAB to Gizu's Play
Console internal testing track (`io.gizu.android`). Play may sign installed apps
with a different certificate from the upload key; authorize the Play app-signing
SHA-256 in `gizu.io/.well-known/assetlinks.json` before testing passkeys.

The profile explicitly sets the Render API URL and native passkey mode. Local,
IP and insecure HTTP endpoints are rejected for release builds. The iOS
pre-install hook builds Rust bindings before CocoaPods. Upload the signed IPA
with Transporter, or submit with the `production` EAS submission profile.
TestFlight is Apple's testing distribution channel for this same production app;
external testing still requires Apple's review and appropriate test information.

`ITSAppUsesNonExemptEncryption` remains false for the current standard-cryptography
implementation and distribution excluding France. Keep France excluded and
revisit the declaration before changing cryptography or distribution territories.
This setting does not disable encryption or establish completion of all
export-reporting obligations.

Release-mode native checks:

```sh
GIZU_IOS_TEST_CONFIGURATION=Release npm run stored-signer:test:ios
```

Local production prebuild (does not supply signing credentials):

```sh
EXPO_NO_DOTENV=1 GIZU_BUILD_VARIANT=production npx expo prebuild --platform ios
```

## Native build diagnostics and CI reports

Before compiling the stored signer, validate its toolchain without changing generated files:

```sh
bash mobile/modules/gizu-stored-signer/scripts/build.sh android --check
# macOS only:
bash mobile/modules/gizu-stored-signer/scripts/build.sh ios --check
```

Both commands use the pinned Rust toolchain in `core/rust-toolchain.toml`. Android
requires the `aarch64-linux-android` Rust target and NDK `27.1.12297006` under
`ANDROID_HOME` (or an explicit `ANDROID_NDK_HOME`). iOS requires full Xcode and both
`aarch64-apple-ios` and `aarch64-apple-ios-sim` Rust targets. Failures print the missing
prerequisite before compiling. These checks cover signer compilation; app builds
also require the Java/CocoaPods and signing setup described above.

Build outputs always use the signer's `core/target` directory so an inherited
`CARGO_TARGET_DIR` cannot make bindings or library-copy steps read stale artifacts.
The scripts require macOS or Linux; Windows CI tests JavaScript only.

PR CI cancels older runs for the same branch/PR. All jobs have time limits; release
validation lets Linux and Windows checks finish independently. Failed Android builds upload available
Gradle test reports. Failed iOS jobs upload available Xcode `.xcresult` bundles for
native tests and app compilation. Download them from the workflow run's Artifacts
section; open `.xcresult` bundles in Xcode. Reports and coverage are retained for
seven days; failures before a report is created still require the Actions step log.
Artifacts exclude signing credentials and wallet storage.

To retain a native iOS test report locally, choose a new output path:

```sh
cd mobile
GIZU_IOS_TEST_RESULTS=/tmp/gizu-native-tests.xcresult npm run stored-signer:test:ios
```

An existing result path is rejected, preserving the earlier report. If there is no
available iPhone simulator, install an iOS runtime in Xcode before rerunning tests.
Preflight regression tests use stub tools and do not compile or authenticate:
`node --test mobile/scripts/tests/native-build.test.cjs`.

## Mobile analytics

Optional PostHog analytics records allowlisted navigation screen names only.
Set `EXPO_PUBLIC_POSTHOG_KEY` to a public project key (`phc_...`) and
`EXPO_PUBLIC_POSTHOG_HOST` to its HTTPS origin, normally
`https://us.i.posthog.com` or `https://eu.i.posthog.com`. The US host is the default.
Whitespace is trimmed; invalid keys, malformed hosts, URL credentials, paths,
queries and fragments disable capture. Never use a personal API key (`phx_...`).

Leave the key empty for ordinary local development. For analytics verification,
use a dedicated test project in local builds and the EAS `preview` environment
used by TestFlight. Configure the production environment separately with its
production project key. Values in EAS-managed environments can enable analytics
without appearing in `eas.json`; verify the selected environment before building.
Public Expo variables are bundled at build time: rebuild after changing them.
Jest's default analytics service stays disabled even when these variables are set.

The service initializes lazily and contains SDK failures. It sends one `$screen`
event per focused-route transition, including back navigation, and starts again
when the wallet session recreates navigation. Route keys are used only locally
for deduplication. Parameters, URLs, wallet addresses, amounts and transaction
hashes are not attached. Automatic lifecycle events, touch capture, replay,
exception capture, surveys and feature-flag preloading are disabled. The outbound
filter drops events other than `$screen`.

Events still include PostHog's anonymous installation/session identifiers and
standard SDK device/app metadata (such as OS, app version and device model).
`personProfiles: "identified_only"` does not remove this metadata. We do not
identify users or link analytics to wallet accounts. SDK configuration requests
may still occur; this is not a promise that only event-upload requests are made.

Tests inject `AnalyticsService` into `AppRoot` and mock PostHog only at the service
boundary. Add new screen names to the allowlist deliberately. Before release,
rebuild both native apps and inspect actual payloads in the dedicated test project,
including cold-start deep links, screen/back navigation and session replacement.
No production dashboard or privacy declaration is automatically changed by this code.

## Mainnet portfolio and Confidential Earn

The mainnet session composes `MainnetWalletProvider` and `EarnProvider`. Swap and Earn
share the native public-account portfolio. Native storage owns account selection,
balance synchronization and signing keys; JavaScript receives public snapshots and
per-account funding terms. Opening the app or returning to the foreground refreshes
the native portfolio. No hosted account catalogue or DeBank indexer is used.

Funding a budget across multiple public accounts retains a separate fee cap and
reserve for each account. All unsigned child plans are saved natively before the first
account can be approved, allowing recovery after interruption. One native batch review and passkey authorization covers the selected source operations; their journals and settlement checks remain separate. Expired unsigned quotes refresh the same saved operations and budget before approval.
Earn cycles retain distinct destination pairs and journals; cycle zero preserves the
legacy v1 intent, while later cycles use v2 identities.

The batch approval uses the existing 15-minute signing session and ends when its
native screen/session closes or reviewed terms change. Transaction deadlines and
fresh native fee checks still apply. See the [multi-account implementation plan](../research/confidential-earn/MULTI-ACCOUNT-MVP-PLAN.md).

Native token and vault-position rows display token amounts independently from the
public Monad USDC total. A USDC valuation appears only when native data supplies it;
unpriced assets and incomplete balance coverage are labeled explicitly.
