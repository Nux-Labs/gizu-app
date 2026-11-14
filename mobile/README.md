# Gizu mobile

Expo SDK 57 native development app for iOS and Android. Normal startup uses the
stored-wallet signer, native passkey create/unlock and the Home, Vaults, Swap and
Account tabs. A newly created wallet must save and reopen its encrypted backup
before Home opens. Restore requires that file and the original passkey. This is
local wallet access, not backend authentication. Wallet secrets and signing
approval stay native; physical-iPhone acceptance remains pending.

Home shows public Monad USDC, authenticated confidential cash, tracked tokens and
supported vault positions, with observed USD valuations and explicit missing/stale
states. Receive shows the Monad funding address. Direct public-USDC Send remains
unavailable. Swap executes the native confidential route to eligible Robinhood
stocks; selling a selected stock covers all eligible owned holder wallets and
leaves verified proceeds in confidential cash. **Withdraw from Gizu** is a separate,
Android-capability-gated distribution from private cash to fresh Monad recipients.
Activity contains this device's completed/cancelled swap summaries, not incoming
or external transaction indexing.

Vaults reads the backend catalog. Supported deposits enter Confidential Earn;
Android supports the guided Robinhood amount/review/progress journey and saved
investment management. iOS supports the staged Ethereum vault execution boundary,
not the complete guided funding journey. See [product capabilities](../docs/feature-plans/PARITY.md),
[Confidential Earn](../docs/internal/CONFIDENTIAL_EARN.md) and
[confidential withdrawals](../docs/internal/CONFIDENTIAL_WITHDRAWALS.md).

Normal startup has no simulated passkey mode or mock financial providers. Historical
M2–M5 journeys remain test fixtures; `debug:ui` is an isolated visual playground.
The web invitation form persists through the backend, while mobile's retained
Request access route still uses a mock service and creates no waitlist entry.

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

After generating the native Android project and signer libraries, a local Gradle
release can be built from `mobile/android/`. The following example uses a macOS
Homebrew JDK path; set `JAVA_HOME` for your installation:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@17 \
NODE_ENV=production \
GIZU_BUILD_VARIANT=production \
EXPO_PUBLIC_API_URL=https://api.gizu.io \
EXPO_PUBLIC_PASSKEY_MODE=native \
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Use Node 24 on PATH. The signer supports this arm64 APK target. Install
`mobile/android/app/build/outputs/apk/release/app-release.apk` with
`adb install -r <path-to-apk>`, then open Gizu from the phone's app list. USB is only
needed for installation. Mobile source changes require rebuilding/reinstalling;
backend catalog/environment changes require a Render deployment and app refresh.

For an existing installation, retain its Android application ID and signing
keystore when updating. Historical local testing used `com.example.gizu.dev`;
checked-in configuration now uses `io.gizu.android`. Inspect the installed app and
generated project before updating because prebuild can replace that local identity. Never uninstall to resolve a signing mismatch: installation identity
also determines access to the encrypted wallet storage. Local test releases can use development signing; store distribution has separate
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
without coverage or Expo Doctor. See the [repository CI guide](../README.md#quality-and-releases)
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

See [FOUNDATION.md](../docs/internal/FOUNDATION.md) for version decisions and the validation
record, and [PARITY.md](../docs/feature-plans/PARITY.md) for the current product scope.

## Product UI and historical fixtures

The current journey contract is [PARITY.md](../docs/feature-plans/PARITY.md). Shared
screens use safe areas, content Back actions, floating bottom tabs, large-text
wrapping and reduced motion. The app uses Helvetica Neue on iOS and the bundled,
owner-licensed HelveticaNeue family on Android; small monospace labels use the
system font. Navigation pushes use `ios_from_right`; modal sheets retain platform
behavior. Home keeps observed USD balance history separately from legacy USDC totals.

M3 portfolio/catalog snapshots, synthetic chart windows, M4 trading and transfer
ledgers, and M5 fixture inbox/profile flows are isolated test contracts. They do not
describe the normal mainnet runtime. See [Trading](../docs/internal/TRADING.md) and
[Account](../docs/internal/ACCOUNT.md) for fixture rules and current local preferences.
Native sessions use an empty inbox; push delivery, FX, statements and support
messaging remain unavailable. Account includes the actual address, backup/recovery
management, push-alert preference, mascot animation preference and disconnect.

Historical simulator/device observations remain historical evidence; this source
review does not establish fresh native, accessibility, provider or funded acceptance.

## Signer migration and developer diagnostics

The old Gizu signer is preserved but disconnected from app access, diagnostics and
native autolinking. `npm start` opens the existing app. Android and iOS 18+ development wallets
require native save-and-reopen backup verification before entering Home. Account
includes backup management; the explicit testnet harness uses native transfer approval/history,
and normal Activity uses saved swap summaries. iOS signing uses the replacement Swift module; physical-device acceptance is pending. No fallback creates a demo or legacy wallet.

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
stable protocol ID before display name. Public cash balances use Monad mainnet USDC;
Home also values supported private cash, tokens and vault positions.
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
and keep the registered upload keystore. The checked-in Android version code is 11; inspect `app.config.ts` before incrementing it.
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
use a dedicated test project in local builds. The EAS `preview` profile inherits
the production environment; `testflight` is also an alias of `production`. Configure
the selected EAS environment deliberately before each diagnostic or distribution build. Values in EAS-managed environments can enable analytics
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
Earn cycles retain distinct destinations and journals. Legacy cycles preserve their
saved hold/invest pair; current amount-aware distributions can allocate one to five
investment wallets with saved weights. Private Account 2 credit is a separate funding
source and is never represented as an ordinary public account.

The batch approval uses the existing 15-minute signing session and ends when its
native screen/session closes or reviewed terms change. Transaction deadlines and
fresh native fee checks still apply. See the [multi-account integration reference](../docs/internal/CONFIDENTIAL_EARN.md#october-1-multi-account-refresh-and-approval).

Native token and vault-position rows display token amounts independently from the
public Monad USDC total. A native valuation or the bounded catalog stock-price estimate can supply USD value;
unpriced assets and incomplete balance coverage are labeled explicitly.
