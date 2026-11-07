<h1 align="center">Gizu</h1>
<p align="center">A passkey-powered mobile wallet for private investment journeys.</p>
<p align="center">
  <a href="https://gizu.io">Website</a> ·
  <a href="docs/app-guide/MOBILE_LOCAL_DEVELOPMENT.md">Run locally</a> ·
  <a href="docs/feature-plans/SWAP_ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

## Why Gizu

Managing investments across chains should not require managing every technical
step yourself. Gizu brings a USDC portfolio, token discovery and confidential swap
flows into one iOS and Android app, with passkey access and native transaction
approval.

Gizu uses confidential routing and fresh destination wallets to reduce the direct
public connection between a funding wallet and investment holdings. The app
coordinates the route, tracks progress and keeps recovery state when an operation
needs to continue later.

- **Open with a passkey.** Access your wallet through the native device flow;
  recover it with an encrypted backup and the original passkey.
- **See your portfolio in one place.** View public Monad USDC balances and inspect
  token holdings and vault positions without manually navigating each account.
- **Discover before you trade.** Search tokens across Ethereum, Monad and Robinhood
  Chain, with eligibility checks before starting a swap.
- **Buy and return to USDC.** Supported swaps route Monad USDC through confidential
  credit into Robinhood token purchases; selling returns proceeds to Monad USDC.
- **Stay in control.** Wallet keys and signing stay in the native wallet layer.
  Paused operations retain state for reconciliation and, when required, fresh approval.

## What is available

The mobile app is the primary wallet experience and uses mainnet assets. The web
app and research prototypes have different capabilities.

| Area                  | Current scope                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile wallet         | Native passkey access, encrypted backup/restore and public Monad USDC portfolio.                                                                                                                |
| Token discovery       | Catalog browsing on Ethereum (`1`), Monad (`143`) and Robinhood Chain (`4663`).                                                                                                                 |
| Swap                  | The current UI enables eligible Robinhood tokens; the execution path uses Aurora Confidential Intents and 1inch Fusion. Catalog inclusion alone does not establish a usable quote or liquidity. |
| Holdings and recovery | Native holdings lookup, sell flows and persisted swap recovery. Platform orchestration differs; shared Rust code does not imply complete iOS/Android parity.                                    |
| Vaults and Earn       | Vault discovery plus native Confidential Earn infrastructure. Execution depends on supported routes, configuration and provider readiness; listing a vault does not enable investment in it.    |
| Web app               | React UI with simulated authentication and mock-backed flows, plus backend-connected token discovery. It is not the native signing wallet.                                                      |

**Privacy has boundaries.** Source funding and destination transfers remain public.
Confidential credit is the private middle segment; providers can observe parts of
the route, and timing or amounts may reveal relationships. Gizu does not promise
complete anonymity or guaranteed unlinkability. See the
[illustrated buy/sell flow](docs/feature-plans/AURORA_SWAP_FLOW.md).

## Technical architecture

Gizu separates presentation, native authorization, shared transaction logic and
provider access. This keeps wallet authority out of the JavaScript UI and backend.

| Layer             | Responsibility                                                                                         | Implementation                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Mobile UI         | Navigation, token discovery, portfolio views, user intent and public operation status.                 | React Native, Expo, TypeScript, NativeWind                        |
| Native wallet     | Passkey ceremonies, secure storage, review screens, networking and operation lifecycle.                | Swift on iOS; Kotlin on Android                                   |
| Shared core       | Account derivation, portfolio validation, transaction constraints, signing and swap state transitions. | Rust, exposed to native code through UniFFI                       |
| Backend           | Catalogs, provider credentials, unsigned preparation, request validation, relay and settlement status. | Fastify, TypeScript, PostgreSQL                                   |
| External services | Confidential routing, funding/bundling, token orders and chain observations.                           | Aurora Confidential Intents, Pimlico, 1inch Fusion and chain RPCs |
| Web surfaces      | Browser app and public landing site.                                                                   | React, TypeScript, Vite                                           |

For a buy, the main asset path is:

```text
Monad USDC → Aurora confidential credit → Robinhood USDG → selected token
```

The native layer drives a persisted Rust state machine through requests, waits,
reviews, approvals and settlement checks. These steps are not one atomic
cross-chain transaction: funding, payouts and orders can complete separately.
Recovery reconciles saved state with provider and chain observations before
continuing. Provider API keys stay on the backend; wallet secrets and raw signing
material do not cross into the React Native UI.

Read the [swap architecture](docs/feature-plans/SWAP_ARCHITECTURE.md),
[provider contracts](docs/feature-plans/SWAP_CONTRACTS.md) and
[persistence/recovery design](docs/feature-plans/SWAP_PERSISTENCE.md) for the
full ownership and trust boundaries.

## Repository map

Each application has its own dependencies, lockfile and scripts.

| Path                                                                              | Contents                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [mobile/](mobile/README.md)                                                       | Primary iOS/Android app, shared UI and functional tests.          |
| [mobile/modules/gizu-stored-signer/](mobile/modules/gizu-stored-signer/README.md) | Active native wallet module, Swift/Kotlin adapters and Rust core. |
| [backend/](backend/)                                                              | API, provider adapters, catalogs and Swap/Earn gateways.          |
| [frontend/](frontend/README.md)                                                   | Browser application and hosted passkey association files.         |
| [landing/](landing/)                                                              | Public marketing website.                                         |
| [docs/](docs/README.md)                                                           | Setup guides, internal references and detailed technical designs. |
| [research/](research/)                                                            | Isolated experiments and recorded investigation evidence.         |
| [brand/](brand/README.md)                                                         | Logo, social assets and brand references.                         |

## Get started

Use Node 24 and npm; check [mobile/package.json](mobile/package.json) for the
supported versions. Native builds also need Rust and the relevant Android or
Apple toolchain. Install dependencies separately in each app you work on.

### Mobile

Start with the [mobile local development guide](docs/app-guide/MOBILE_LOCAL_DEVELOPMENT.md).
It covers native prerequisites, iOS simulators, Android devices and USB-only
connections. The wallet needs a native development build; Expo Go is not sufficient.

```sh
npm --prefix mobile ci
```

Set `EXPO_PUBLIC_API_URL` in `mobile/.env`, then follow the platform build steps in
the guide. Public environment variables are bundled into the app; never put
provider keys in them. Development builds can use real mainnet funds.

### Backend

Use [backend/.env.example](backend/.env.example) for configuration and the
[backend guide](docs/app-guide/BACKEND_DEPLOYMENT.md) for database, provider and
simulation requirements.

```sh
npm --prefix backend ci
cp backend/.env.example backend/.env
# Configure backend/.env before starting.
npm --prefix backend run dev
```

### Web and landing

```sh
npm --prefix frontend ci
npm --prefix frontend run dev

# In another terminal, if working on the marketing site:
npm --prefix landing ci
npm --prefix landing run dev
```

Open the URL printed by each development server. Backend-connected web token
search needs the provider configuration described in the
[frontend README](frontend/README.md).

## Quality and releases

| Validation                             | Scope                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PRs and pushes to `main`               | Mobile types, formatting, lint, build-script tests and JavaScript tests; backend type checks, tests and compilation; frontend/landing type checks and builds.      |
| `v*` tags or manual release validation | Adds mobile Linux/Windows checks, Expo Doctor, coverage thresholds, Rust tests/formatting/Clippy, Android native tests/build and iOS native tests/simulator build. |

Run the relevant checks locally:

```sh
npm --prefix mobile run typecheck
npm --prefix mobile run format:check
npm --prefix mobile run lint
npm --prefix mobile test
# Expanded mobile checks:
npm --prefix mobile run check

npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix landing run build
```

Run `just gas-check` for offline checks of production gas calculations, paymaster
approval stabilization and shared TypeScript/Rust vectors. Use
`just gas-check-native` to include the native Rust tests. Provider diagnostics are
opt-in and read-only; see [gas management](docs/internal/GAS_MANAGEMENT.md).

See the [workflow definitions](.github/workflows/) for exact jobs. Native changes
need release validation even when PR checks pass. CI does not deploy services,
upload signed store builds or prove live provider settlement; backend tests use
test doubles. Distribution and device acceptance are separate steps.

## Documentation by audience

| Start here                                     | What you will find                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| [App guides](docs/app-guide/README.md)         | Simple setup, deployment, signing and passkey configuration steps.    |
| [Internal references](docs/internal/README.md) | Architecture explanations, diagnostics and implementation boundaries. |
| [Feature plans](docs/feature-plans/README.md)  | Detailed designs, contracts, tradeoffs and acceptance criteria.       |

For an interrupted swap, use the [swap failure guide](docs/internal/SWAP_FAILURES.md).
For wallet access problems, start with [passkey troubleshooting](docs/internal/PASSKEY_TROUBLESHOOTING.md).
