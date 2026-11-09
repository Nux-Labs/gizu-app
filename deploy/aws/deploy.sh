#!/usr/bin/env bash
# Installed by an operator, never executed from an uploaded release.
set -Eeuo pipefail
umask 022
root=${GIZU_ROOT:-/srv/gizu}
config=${GIZU_CONFIG:-/etc/gizu}
release=${1:?Usage: deploy.sh FULL_COMMIT_SHA}
[[ $# == 1 && $release =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ -f "$config/deploy-enabled" ]] || { echo 'Cutover gate is closed' >&2; exit 1; }
mkdir -p "$root/state" "$root/releases"
exec 9>"$root/state/deploy.lock"
flock -w 600 9
candidate="$root/releases/$release"
[[ ! -e "$candidate" ]] || { echo 'Release already exists; use a new commit' >&2; exit 1; }
incoming="$root/incoming/$release"
[[ -d "$incoming" && ! -L "$incoming" ]] || exit 1
[[ -z $(find "$incoming" -type l -print -quit) ]] || exit 1
for file in api-image landing/index.html frontend/index.html associations/apple-app-site-association associations/assetlinks.json; do
  [[ -s "$incoming/$file" ]] || { echo "Missing release file: $file" >&2; exit 1; }
done
image=$(cat "$incoming/api-image")
[[ $image =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$ ]] || exit 2
previous_image=''
previous_site=''
[[ ! -f "$root/state/api-image" ]] || previous_image=$(cat "$root/state/api-image")
[[ ! -L "$root/current" ]] || previous_site=$(readlink "$root/current")
compose() { API_IMAGE="$1" docker compose -f "$config/compose.yml" "${@:2}"; }
publish_site() {
  ln -s "$1" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
}
changing=0
recover() {
  trap - ERR INT TERM HUP
  if [[ $changing == 1 ]]; then
    echo 'Release failed; attempting previous API once' >&2
    compose "$image" stop api || true
    if [[ -n "$previous_image" ]]; then
      if compose "$previous_image" up -d --no-deps --wait --wait-timeout 90 api; then
        echo 'Previous API restored; deployment remains failed' >&2
      else
        echo 'RECOVERY FAILED: operator intervention required' >&2
      fi
    else
      echo 'No previous API exists; operator intervention required' >&2
    fi
    if [[ -n "$previous_site" ]]; then
      rm -f "$root/current.next"
      publish_site "$previous_site"
    else
      rm -f "$root/current"
    fi
    # Restore metadata too if interruption happened just after its promotion.
    if [[ -n "$previous_image" ]]; then
      printf '%s\n' "$previous_image" > "$root/state/api-image.next"
      mv -f "$root/state/api-image.next" "$root/state/api-image"
    else
      rm -f "$root/state/api-image"
    fi
  fi
  exit 1
}
trap recover ERR INT TERM HUP
# Prepare everything before stopping the only API. No prune, DB reversal or retry loop.
compose "$image" pull api
mv "$incoming" "$candidate"
chmod -R a+rX "$candidate"
changing=1
compose "${previous_image:-$image}" stop api
compose "$image" up -d --no-deps --wait --wait-timeout 90 api
# Switch both sites and associations together only after API health succeeds.
publish_site "$candidate"
printf '%s\n' "$image" > "$root/state/api-image.next"
mv -f "$root/state/api-image.next" "$root/state/api-image"
changing=0
trap - ERR INT TERM HUP
echo "Deployed $release"
