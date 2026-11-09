#!/usr/bin/env bash
# Disposable local/CI smoke: no real providers, credentials or funded operations.
set -euo pipefail
image=${1:?Usage: runtime.sh API_IMAGE}
name="gizu-smoke-$$"
cleanup() {
  docker rm -fv "$name-api" "$name-db" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$name" >/dev/null
docker run -d --name "$name-db" --network "$name" --network-alias db \
  -e POSTGRES_PASSWORD=smoke-only -e POSTGRES_DB=gizu postgres:17-bookworm >/dev/null
for _attempt in {1..30}; do
  if docker exec "$name-db" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name-db" pg_isready -U postgres >/dev/null
docker run -d --platform linux/amd64 --name "$name-api" --network "$name" \
  --init --read-only --tmpfs /tmp:size=128m,mode=1777 --memory 3g --pids-limit 256 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e DATABASE_URL=postgres://postgres:smoke-only@db:5432/gizu \
  -e MERKL_API_URL=https://example.invalid -e MERKL_API_KEY=smoke-only \
  -e ONEINCH_API_KEY=smoke-only -e AURORA_API_KEY=smoke-only -e PIMLICO_API_KEY=smoke-only \
  "$image" >/dev/null
ready=0
for _attempt in {1..30}; do
  if docker exec "$name-api" node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
docker stop -t 75 "$name-api" >/dev/null
[[ $(docker inspect -f '{{.State.ExitCode}}' "$name-api") == 0 ]]
echo 'Container health with PostgreSQL and SIGTERM shutdown passed'
