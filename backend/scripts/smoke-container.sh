#!/usr/bin/env bash
# Exercises only disposable containers. No production credentials or provider calls.
set -euo pipefail
image=${1:?Usage: smoke-container.sh LOCAL_API_IMAGE}
name="gizu-smoke-$(date +%s)-$$"
cleanup() {
  status=$?
  trap - EXIT
  if [[ $status != 0 ]]; then docker logs "$name-api" >&2 || true; fi
  docker rm -fv "$name-api" "$name-db" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker network create --internal "$name" >/dev/null
docker run -d --name "$name-db" --network "$name" --network-alias db \
  -e POSTGRES_PASSWORD=smoke-only -e POSTGRES_DB=gizu postgres:18-bookworm >/dev/null
for attempt in {1..30}; do
  if docker exec "$name-db" pg_isready -U postgres -d gizu >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name-db" pg_isready -U postgres -d gizu >/dev/null

docker run -d --platform linux/amd64 --name "$name-api" --network "$name" \
  -e DATABASE_URL=postgresql://postgres:smoke-only@db:5432/gizu \
  -e MERKL_API_URL=https://example.invalid -e MERKL_API_KEY=smoke-only \
  -e ONEINCH_API_KEY=smoke-only -e AURORA_API_KEY=smoke-only -e PIMLICO_API_KEY=smoke-only \
  -e EARN_GATEWAY_RECOVERY_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
  "$image" >/dev/null
ready=0
for attempt in {1..30}; do
  if docker exec "$name-api" node -e "fetch('http://127.0.0.1:3000/v1/health', {signal: AbortSignal.timeout(3000)}).then(async r => { const body = await r.json(); process.exit(r.ok && body.result?.status === 'ok' ? 0 : 1); }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [[ $(docker inspect -f '{{.State.Running}}' "$name-api") != true ]]; then break; fi
  sleep 1
done
[[ $ready == 1 ]] || { echo 'Container database health check failed' >&2; exit 1; }
docker exec "$name-api" node -e "const fs = require('node:fs'); fs.accessSync(process.env.NODE_EXTRA_CA_CERTS); if (!fs.statSync('/etc/ssl/certs/ca-certificates.crt').size) throw Error('System TLS roots are missing'); if (process.getuid() === 0) process.exit(1);"
docker exec "$name-api" /app/backend/.runtime/anvil-v1.8.3/anvil-fork --version
# Match the ECS default: SIGTERM to Node as PID 1, then up to 30 seconds to stop.
docker stop --time 30 "$name-api" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name-api")
[[ $code == 0 ]] || { echo "Expected clean SIGTERM shutdown, got exit code $code" >&2; exit 1; }
echo 'PostgreSQL 18 health, packaged Anvil, RDS CA presence and clean SIGTERM shutdown passed'
