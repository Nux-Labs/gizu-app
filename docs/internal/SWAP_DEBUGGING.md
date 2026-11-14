# Confidential swap debugging

The active native swap flow can submit mainnet operations. Provider connectivity
checks do not establish funded settlement. Keep passkey/native approval with the person testing the phone.

For phase meanings, pause codes and recovery decisions, see
[Swap failures and recovery](SWAP_FAILURES.md).

## Local setup

Configure `AURORA_API_KEY`, `PIMLICO_API_KEY` and `ONEINCH_API_KEY` in the ignored
`backend/.env`. Also configure `DATABASE_URL` for the local PostgreSQL instance
(see [backend setup](../app-guide/BACKEND_DEPLOYMENT.md)). Do not put provider keys
in mobile configuration or share them in logs.

From `backend/`:

```sh
node --experimental-transform-types scripts/swap-preflight.ts
npm run dev
```

Preflight reports only credential presence and read-only Aurora token-registry and
NEAR auth-salt results. It never quotes, authenticates, signs or submits. It does
not validate the 1inch/Pimlico credentials beyond their presence.

The production API is `https://api.gizu.io`. For USB Android development, start
Metro from `mobile/` with the local JavaScript API:

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:3000 npm start -- --localhost --port 8083
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8083 tcp:8083
adb shell setprop log.tag.GizuSwap DEBUG
adb logcat -v time -s GizuSwap:D '*:S'
```

The environment variable controls JavaScript-selected requests. Native Earn uses
its own build-time endpoint: build debug with `-PgizuEarnBackend=usb` to select
port 3000 for that gateway; releases use `https://api.gizu.io`. Recovery, portfolio
and restored-operation calls can still use the hosted API. Do not assume the USB
setup isolates all native traffic.

Rebuild/install the development app after native changes. Preserve installed app
data and its wallet/operation journal; do not uninstall to clear a failed swap.

## Diagnostic layers

- Metro `[swap]`: action started/completed/failed and token/status load failures.
  These logs are development-only. Completion means the native call returned,
  not that a swap settled; inspect the phase shown by the app.
- Android `GizuSwap`: persisted phase, step, pause code, numeric request sequence,
  response status and elapsed milliseconds. Status `0` means transport failed.
- Backend `swap.gateway`: route template, HTTP status, elapsed time and Fastify's
  request ID. The shared `private.request` hook also records private route template,
  status and latency. `swap.error` adds the application error code without the raw
  exception.
- Backend `swap.provider`: fixed Aurora operation label, provider HTTP status,
  header-response latency and transport outcome. Gateway latency covers the full
  request. Provider events can be compared by time/operation; they do not currently
  carry the gateway request ID, so do not assume precise correlation under concurrency.

Diagnostics omit request/response bodies, bearer tokens, API-key URLs, wallet
addresses, exported operation state and signatures. Share the phase/step/pause
code and HTTP status rather than dumping provider objects or entire device logs.

## First device run

1. Open the existing wallet and Swap. Confirm tokens load and the funding address
   appears. Account 1 funding is separate from the ordinary Account 0 wallet.
2. If an operation exists, inspect/refresh its status before starting another.
3. Only after choosing the amount and reviewing mainnet costs, start through native
   approval. Leave passkey interaction to the tester. A paused or unknown operation
   must be reconciled before retrying; do not clear storage or create another wallet.
4. Record the failing native step and matching gateway/provider status. Fix that
   boundary and repeat its focused mocked regression test before another funded run.

Disable device diagnostics afterward:

```sh
adb shell setprop log.tag.GizuSwap INFO
```
