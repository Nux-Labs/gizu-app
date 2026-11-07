# Gizu command shortcuts. Run `just` from any directory in this repository.
# Install just on macOS: brew install just
# Node/npm requirements: mobile/package.json. Native prerequisites:
# docs/app-guide/MOBILE_LOCAL_DEVELOPMENT.md and mobile/modules/gizu-stored-signer/README.md.
# Android needs JDK 17 (JAVA_HOME), Android SDK (ANDROID_HOME), NDK and Rust.
# iOS needs macOS, Xcode, CocoaPods and Rust. EAS builds need an Expo login/signing credentials.
# Local release builds use eas.json's hosted backend, ignoring mobile/.env.
# Increment android.versionCode / ios.buildNumber in mobile/app.config.ts before a new store upload.
# Build outputs below are ignored by Git and replaced on the next build of the same type.

set shell := ["sh", "-cu"]
set windows-shell := ["cmd.exe", "/D", "/C"]

# Show all commands; does not install, build or start anything.
default:
    @just --list --unsorted

# Install dependencies for all four apps from their lockfiles.
install: mobile-install backend-install frontend-install landing-install

# Common checks: mobile types/lint/format, backend types/tests and web builds.
check: mobile-check-fast backend-check frontend-build landing-build

# --- Mobile setup and development ---

# Install mobile dependencies.
mobile-install:
    npm --prefix mobile ci

# Start Metro for the native development app; keep this terminal open.
mobile-start:
    npm --prefix mobile start

# Restart Metro with its cache cleared.
mobile-start-clean:
    npm --prefix mobile start -- --clear

# List connected Android devices and their authorization state.
mobile-devices:
    adb devices -l

# Start Metro over USB without shared Wi-Fi; connect one authorized phone.
[unix]
mobile-usb:
    adb reverse tcp:8081 tcp:8081
    env REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 npm --prefix mobile start -- --host lan

# Start Metro over USB on Windows; connect one authorized phone.
[windows]
mobile-usb:
    adb reverse tcp:8081 tcp:8081
    set "REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1" && npm --prefix mobile start -- --host lan

# Build native bindings, then install on an Android phone; run mobile-usb separately.
[unix]
mobile-android: mobile-native-android
    npm --prefix mobile run android -- --device --no-bundler

# Build native bindings, then launch the iOS simulator; run mobile-start separately.
[macos]
mobile-ios: mobile-native-ios
    npm --prefix mobile run ios -- --no-bundler

# --- Mobile checks ---

# Run TypeScript, lint and formatting checks without changing files.
mobile-check-fast: mobile-typecheck mobile-lint mobile-format-check

# Full check: types, formatting, lint, Expo Doctor and tests with coverage.
mobile-check:
    npm --prefix mobile run check

# Check mobile TypeScript.
mobile-typecheck:
    npm --prefix mobile run typecheck

# Check mobile lint rules.
mobile-lint:
    npm --prefix mobile run lint

# Check mobile formatting without rewriting files.
mobile-format-check:
    npm --prefix mobile run format:check

# Format mobile files; rewrites files in mobile/.
mobile-format:
    npm --prefix mobile run format

# Run functional tests with mocked services.
mobile-test:
    npm --prefix mobile run test:functional

# Run all mobile JavaScript tests.
mobile-test-all:
    npm --prefix mobile test

# Run all mobile JavaScript tests with coverage.
mobile-coverage:
    npm --prefix mobile run test:coverage

# Check Expo dependency compatibility and configuration.
mobile-doctor:
    npm --prefix mobile run doctor

# Verify that both platforms' JavaScript bundles export successfully.
mobile-export:
    npm --prefix mobile run export

# --- Native wallet ---

# Generate Rust/Kotlin bindings and Android native signer libraries (macOS/Linux).
[unix]
mobile-native-android:
    npm --prefix mobile run stored-signer:build -- android

# Generate Rust/Swift bindings and iOS device/simulator libraries (macOS).
[macos]
mobile-native-ios:
    npm --prefix mobile run stored-signer:build:ios

# Run shared Rust wallet tests.
mobile-native-test:
    npm --prefix mobile run stored-signer:test

# Run Swift wallet tests on an available iPhone simulator (macOS).
[macos]
mobile-native-test-ios:
    npm --prefix mobile run stored-signer:test:ios

# Check Kotlin formatting without rewriting files.
mobile-kotlin-check:
    npm --prefix mobile run format:kotlin:check

# --- Signed local distribution builds; these do not upload or submit ---

# Android Play Console AAB -> mobile/.expo/releases/gizu.aab (macOS/Linux).
[unix]
[working-directory("mobile")]
mobile-build-android:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "$(uname -s)" == Darwin ]]; then
        if [[ -z "${JAVA_HOME:-}" ]]; then
            JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || true)
            if [[ -z "$JAVA_HOME" ]] && command -v brew >/dev/null; then
                jdk_prefix=$(brew --prefix openjdk@17)
                JAVA_HOME="$jdk_prefix/libexec/openjdk.jdk/Contents/Home"
            fi
            export JAVA_HOME
        fi
        default_sdk="$HOME/Library/Android/sdk"
    else
        default_sdk="$HOME/Android/Sdk"
    fi
    export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$default_sdk}}"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    if [[ -n "${JAVA_HOME:-}" ]]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
    java -version
    [[ -d "$ANDROID_HOME/platform-tools" ]] || { echo "Android SDK missing at $ANDROID_HOME; set ANDROID_HOME to your SDK directory." >&2; exit 1; }
    mkdir -p .expo/releases
    export EXPO_NO_DOTENV=1
    npm exec --yes --package=npm@11.12.1 --package=eas-cli@24.13.0 -- env -u npm_config_package eas build --platform android --profile production --local --output ./.expo/releases/gizu.aab

# iOS App Store/TestFlight IPA -> mobile/.expo/releases/gizu.ipa (macOS).
[macos]
[working-directory("mobile")]
mobile-build-ios:
    mkdir -p .expo/releases
    env EXPO_NO_DOTENV=1 npx eas-cli build --platform ios --profile production --local --output ./.expo/releases/gizu.ipa

# iOS Ad Hoc IPA for registered tester devices -> mobile/.expo/releases/gizu-adhoc.ipa.
[macos]
[working-directory("mobile")]
mobile-build-ios-adhoc:
    mkdir -p .expo/releases
    env EXPO_NO_DOTENV=1 npx eas-cli build --platform ios --profile preview --local --output ./.expo/releases/gizu-adhoc.ipa

# --- Backend ---

# Install backend dependencies.
backend-install:
    npm --prefix backend ci

# Start local PostgreSQL in Docker; requires backend/.env configuration.
[working-directory("backend")]
backend-db:
    docker compose up -d

# Run the backend with source watching; configure backend/.env first.
backend-start:
    npm --prefix backend run dev

# Check backend TypeScript and run its tests.
backend-check: backend-typecheck backend-test

# Check production gas helpers against shared arithmetic and preparation regressions; no network.
gas-check:
    npm --prefix backend run gas:check

# Include native gas, review, signing and recovery tests; requires Rust/Cargo.
gas-check-native:
    npm --prefix backend run gas:check:native

# Read-only diagnostics. Add --live and supply one request on stdin for provider preparation.
gas-doctor *args:
    npm --prefix backend run gas:doctor -- {{args}}

# Check backend source and test types.
backend-typecheck:
    npm --prefix backend run typecheck

# Run backend tests.
backend-test:
    npm --prefix backend test

# Compile the backend; does not deploy or start it.
backend-build:
    npm --prefix backend run build

# --- Frontend and landing page ---

# Install web frontend dependencies.
frontend-install:
    npm --prefix frontend ci

# Start the web frontend development server.
frontend-start:
    npm --prefix frontend run dev

# Typecheck and build the web frontend.
frontend-build:
    npm --prefix frontend run build

# Install landing page dependencies.
landing-install:
    npm --prefix landing ci

# Start the landing page development server (port 5174).
landing-start:
    npm --prefix landing run dev

# Typecheck and build the landing page.
landing-build:
    npm --prefix landing run build
