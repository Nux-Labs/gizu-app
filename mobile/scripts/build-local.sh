#!/usr/bin/env bash
# Local signed builds only; never uploads or submits.
set -euo pipefail
cd "$(dirname "$0")/.."
platform="${1:-}"
profile="${2:-production}"
case "$platform" in
    android) extension=aab ;;
    ios) extension=ipa ;;
    *) echo "Usage: build-local.sh <ios|android> [production|adhoc]" >&2; exit 2 ;;
esac
case "$profile" in
    production) output="gizu.$extension" ;;
    adhoc)
        if [[ "$platform" == android ]]; then output=gizu-adhoc.apk; else output=gizu-adhoc.ipa; fi
        ;;
    *) echo "Profile must be production or adhoc." >&2; exit 2 ;;
esac
if [[ "$platform" == ios && "$(uname -s)" != Darwin ]]; then
    echo "Local iOS builds require macOS." >&2
    exit 2
fi
if [[ "$platform" == android ]]; then
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
fi
mkdir -p .expo/releases
export EXPO_NO_DOTENV=1
npm exec --yes --package=npm@11.12.1 --package=eas-cli@24.13.0 -- env -u npm_config_package eas build --platform "$platform" --profile "$profile" --local --output "./.expo/releases/$output"
