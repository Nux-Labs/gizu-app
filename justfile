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

# Mobile commands live in mobile/justfile, e.g. just mobile ios adhoc.
[unix]
[positional-arguments]
mobile *args:
    @just --justfile mobile/justfile "$@"

[windows]
mobile *args:
    @just --justfile mobile/justfile {{args}}

# Hidden compatibility shortcuts for existing documentation and scripts.
[private]
mobile-install:
    @just --justfile mobile/justfile install

[private]
mobile-start *args:
    @just --justfile mobile/justfile start {{args}}

[private]
mobile-start-clean:
    @just --justfile mobile/justfile start-clean

[private]
mobile-devices:
    @just --justfile mobile/justfile devices

[private]
mobile-usb:
    @just --justfile mobile/justfile usb

[private]
mobile-android:
    @just --justfile mobile/justfile dev-android

[private]
mobile-ios:
    @just --justfile mobile/justfile dev-ios

[private]
mobile-check-fast:
    @just --justfile mobile/justfile check-fast

[private]
mobile-check:
    @just --justfile mobile/justfile check

[private]
mobile-typecheck:
    @just --justfile mobile/justfile typecheck

[private]
mobile-lint:
    @just --justfile mobile/justfile lint

[private]
mobile-format-check:
    @just --justfile mobile/justfile format-check

[private]
mobile-format:
    @just --justfile mobile/justfile format

[private]
mobile-test:
    @just --justfile mobile/justfile test

[private]
mobile-test-all:
    @just --justfile mobile/justfile test-all

[private]
mobile-coverage:
    @just --justfile mobile/justfile coverage

[private]
mobile-doctor:
    @just --justfile mobile/justfile doctor

[private]
mobile-export:
    @just --justfile mobile/justfile export

[private]
mobile-native-android:
    @just --justfile mobile/justfile native-android

[private]
mobile-native-ios:
    @just --justfile mobile/justfile native-ios

[private]
mobile-native-test:
    @just --justfile mobile/justfile native-test

[private]
mobile-native-test-ios:
    @just --justfile mobile/justfile native-test-ios

[private]
mobile-kotlin-check:
    @just --justfile mobile/justfile kotlin-check

[private]
mobile-build *args:
    @just --justfile mobile/justfile build {{args}}

[private]
mobile-build-android:
    @just --justfile mobile/justfile build-android

[private]
mobile-build-ios:
    @just --justfile mobile/justfile build-ios

[private]
mobile-build-ios-adhoc:
    @just --justfile mobile/justfile build-ios-adhoc

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
