# Backend runtime and provider requirements

For service setup and deployment steps, see the [backend deployment guide](../app-guide/BACKEND_DEPLOYMENT.md).
This reference preserves implementation details and dated verification evidence.
Historical probes do not establish current provider availability.

## Verified release

The installer pins [Foundry v1.8.3](https://github.com/foundry-rs/foundry/releases/tag/v1.8.3),
commit `cae51ad458f6abb64852b7709eb784352429825d`, and this exact archive:

```text
https://github.com/foundry-rs/foundry/releases/download/v1.8.3/foundry_v1.8.3_linux_amd64.tar.gz
SHA-256: 7ca48e6ca3cac1bce1403ca67e5bc1dc3bc1fd818199c9957c7165079c228568
```

The digest was independently read from the official release API and its
[published checksum file](https://github.com/foundry-rs/foundry/releases/download/v1.8.3/foundry_v1.8.3_linux_amd64.sha256),
then checked against the downloaded archive. The extracted `anvil` digest is
`674a06c97a01350cd00241762bbfb01ebcafce9b6e8cbd6c8758ecea6ef4b968`; this is derived
from the verified archive and is checked before executing a cached binary.
The installer extracts only `anvil`, bounds the download to 128 MiB and five minutes,
checks the exact executable version/commit, and copies the maintained fork wrapper.
An offline archive can be supplied with
`npm run runtime:anvil -- --archive /path/to/foundry_v1.8.3_linux_amd64.tar.gz`;
the same digest checks apply.

Checksum pinning checks integrity. Foundry also publishes release attestations;
operators who require provenance verification can use the official
[Foundry verification instructions](https://github.com/foundry-rs/foundry/security)
and `gh attestation verify` with `--repo foundry-rs/foundry` and the fixed release
workflow identity. Updating the pin requires a reviewed artifact/checksum change
and repeating the Linux checks; do not substitute `foundryup` or `latest` in the build.

## Recovery and provider qualification

Retain the recovery key across deploys and restarts. Changing or losing it prevents
verification of existing native-protected payout recovery envelopes. Keep a protected
operator backup; never print it or generate a new key automatically during startup.
Recovery envelopes carry the original immutable unsigned quote/intent context;
native storage retains the nonce/role guard and exact signed bytes for reconciliation.

The default Robinhood lifecycle policy is `gizu-portal-zero-2026-10-12`, based on the inspected API-key portal (zero integrator fee, no collection address/custom rules, confidential configuration inherits public) and captured local/Render quotes. It admits only these service-fee limits:

| Routes | Collectors and maximum bps | Total maximum |
| --- | --- | --- |
| source, withdrawal | `widget_collect.sputnik-dao.near`: 4 | 4 |
| payoutRobinhood, returnRobinhood | `widget_collect.sputnik-dao.near`: 25; `2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805`: 20 | 45 |

The two observed referrals are `aurora-jh500bnyo9` and `aurora-1u3j2qzclc`. This policy bounds observed service charges; it does not claim the collectors' ultimate beneficiaries were independently established. Configured Gizu/integrator fee and application charge are zero. Listed fee bps exclude other costs already reflected in route output. Exact executable fee breakdown, minimum output, gas cap and withdrawal reserve remain bound to native review.

`EARN_AURORA_FEE_QUALIFICATION_JSON` is optional and overrides this default. The existing versioned schema remains supported; a rule's `referral` may be a string, null, or an explicit list of accepted strings. Unknown collectors/referrals, duplicate collectors and excessive fees remain rejected. The default does not qualify Ethereum routes; those require an explicit route policy.

Ordinary native settlement does not require `account/history`. Before each funding/return spend the native engine reads a private balance snapshot, saves it alongside the exact signed transaction, and verifies its origin receipt using the chain's execution policy. Settlement verifies the saved sealed quote, successful route status and authenticated balance delta within the quote's minimum/estimated output. Better execution above the estimate requires negotiated `operation-history-v1` evidence: one authenticated history record with exact route, input, owner, recipient and origin transaction bindings, whose credit equals the observed delta. Missing access or ambiguous evidence fails closed. Source funding and payouts proceed sequentially. The server seals credit evidence under `EARN_GATEWAY_RECOVERY_KEY`; only encrypted native journals retain the operation ownership graph. Both payout legs can reuse either attestation after the balance is spent and after a backend restart.

Outgoing payouts require the exact saved ERC-191 transfer signature, successful quote status, and a canonical finalized token transfer within the quote's output bounds. Native code independently checks receipts and prohibits reuse for the same recipient. Public balances alone do not confirm payouts. These checks trust Aurora's route status/balance service; they are not a cryptographic proof of a confidential ledger transaction.

`EARN_AURORA_HISTORY_QUALIFIED` controls legacy client admission. Missing/false rejects old clients lacking `settlementMode=balance-delta-v1` before new source/return quotes. Ordinary current-client settlement needs no invitation; the above-estimate exception requires live authenticated history access regardless of this admission flag. Old signed journals without a pre-spend snapshot also retain history reconciliation, because inventing their baseline would misattribute funds. Keep the recovery key unchanged. Only current Android builds advertise `earnBalanceDeltaSettlement`; updated JavaScript checks this explicit native capability before planning returns. Updated native reads negotiate history proofs with the `x-gizu-settlement-proof` header. Deploy the backend and install the new APK to use that path; old backends ignore the header and retain bounded settlement. No migration re-signs old spending bytes.

## Catalog validation and caching

Contract addresses must be real nonzero 20-byte EVM addresses.
Optional `asset` metadata takes `{ "address": "0x…", "name": "USD Coin",
"symbol": "USDC", "decimals": 6 }`, using that chain's actual underlying token.
Duplicate chain IDs, duplicate chain/contract pairs, malformed JSON, invalid
addresses and unknown chains stop startup with a field-specific error.
`VAULT_CHAINS=1,4663` selects Ethereum and Robinhood in that order, using built-in
metadata plus optional `CATALOG_CHAINS_JSON` overrides. Known inactive vault
configurations are filtered before adapter construction. Without `VAULT_CHAINS`,
the JSON chain list retains its selection behavior and disabled-chain contracts
still prevent startup. Resolved chains and active contracts enter the cache
fingerprint, so changing the selection does not reuse a previous catalog cache.

The catalog is the configured vault list: built-in native profiles plus explicit promotions. There is no
third-party discovery feed. Each configured vault is looked up through Morpho's public
[GraphQL API](https://docs.morpho.org/developers/earn/tutorials/get-data/).
V1 and V2 are queried separately: a missing non-nullable version otherwise nulls
the entire GraphQL result. Available API metadata wins; environment values fill
missing name/symbol/description/asset fields. Without either source, the name uses
the chain and shortened contract address. Missing yield, TVL and prices are `null`
and displayed as unavailable. Morpho net APY is explicitly labeled APY using
`rateType: "apy"`. History is empty for configured entries because this integration
has no historical Morpho series yet.

Configured rows have stable `configured:<chainId>:<lowercase address>` IDs,
`vaultAddress` and share `symbol` in list/detail responses; other IDs return 404. `CATALOG_VAULTS_JSON` adds promoted entries with `featured: true`
to the built-in profiles. An empty array disables promotions only. Duplicate
chain/address configuration merges, with explicit metadata filling/overriding
built-in fallback metadata; provider metadata still wins. Promotions are filtered
by enabled chains and cannot remove the regular entries. Catalog cache namespace
v4 separates the revised composition from older replacement-list responses.
Before metadata requests or local protocol/search/paging, a non-promoted entry's exact chain/vault identity must
match the deposit planners' `ETHEREUM_PROFILE` or `ROBINHOOD_PROFILE`. Only Pendle
USDC (`1:0x55C1B6e461a6334B567bAF0FEb5D728715446f05`) and Steakhouse USDG
(`4663:0xBeEff033F34C046626B8D0A041844C5d1A5409dd`) qualify. Each vault's underlying contract must
also match its native profile's exact asset, so another canonical stablecoin cannot
substitute for it. Other legitimate USDC/USDG vaults, Aave/Curvance and raw markets
are omitted from the regular catalog. List/detail expose canonical `asset` metadata;
detail/history enforce the same native identity and asset checks for regular entries.
Promotions are an explicit presentation exception: lists/details may include their
configured or Morpho underlying asset, even AUSD, or omit it if unknown. The mobile
Featured label and informational view do not qualify a native deposit. Configured assets provide an outage
fallback, but available Morpho asset metadata remains authoritative.
Morpho lookups are limited to eligible native identities or explicit promotions and cached/coalesced for
five minutes. Configured reads share a five-second deadline; a Morpho outage leaves
configured fallback metadata and unavailable metrics rather than hiding the vault.
The catalog no longer sets `partial`; the mobile screen marks a subset only when a
chain's request fails. Each list response includes `facets.protocols` for the
protocol filter; counts apply search but not the protocol filter.
Persistent response caches are namespaced by configuration so removed chains or
contracts cannot reappear from an earlier configuration's cache.

Catalog configuration cannot extend native signing policies or the pinned
Confidential Earn execution registry. To support another vault, update and verify
the backend deposit planner/profile, the native signer policies in
`mobile/modules/gizu-stored-signer` and the mobile Earn profile registry together,
then extend the catalog's profile mapping in `backend/src/adapters/catalog/native-catalog.ts`.
The backend uses planner identities as its authority; the mobile client independently
requires its native profile match before enabling a deposit. Response cache namespace
`catalog:v4` prevents older replacement-list responses from reappearing after this change.

## Fork isolation and capacity

Anvil binds only to `127.0.0.1` on an allocated free port, with zero generated
accounts and no storage cache. The wrapper limits each child to 1 GiB virtual memory,
60 CPU seconds, one Rayon worker, two Tokio workers and no core dumps. The API
allows at most two concurrent forks per Node process, fails fast at capacity, and
bounds fork wall time to 30 seconds by default (constructor maximum 60 seconds).
Every reference header/chain/hash is verified before simulation. Normal completion,
error and timeout send SIGTERM, then SIGKILL if necessary; child output is discarded
and child environment contains only PATH plus the wrapper's worker settings.

Provision the service with memory above the combined two-fork ceilings plus Node
and service overhead; the wrapper is a per-child ceiling, not a total service limit.
Check actual latency, peak memory and provider rate limits on the selected service
before enabling traffic. `--compute-units-per-second 1000` is Anvil's upstream RPC
rate setting, not an OS CPU limit; the wrapper supplies the CPU limit separately.
Scale instances only with awareness that limits and unsigned quote registries are
process-local. An unknown or expired quote binding fails closed; payout recovery
uses its protected immutable envelope, not an invented surviving cache entry.

Fork funding and impersonation affect disposable loopback state only. The API never
fabricates a live destination balance. A deposit stays invested; any redemption
during deposit planning is isolated simulation solely to estimate a reserve.
Live withdrawal, return and final native sponsorship each require a separate fresh
review. Provider credentials, successful quote admission and a deployed binary do
not themselves authorize a transaction.

## Verification and limits

Run `npm run typecheck`, `npm test` and `npm run build` from `backend`.
The runtime tests reject unsupported platforms, corrupted archives and symlink caches.
The verified Linux Anvil version/commit, offline archive installer, cached installer
and complete `npm run build:render` were exercised successfully in a disposable
`node:24.19.0-bookworm` Linux x86-64 container. The resource-limited wrapper also
started an isolated fork of a second loopback-only Anvil, and read-only RPC verified
that the fork retained the exact pinned upstream block hash. Networking was disabled;
no transactions, research secrets or server credentials were used. This verifies the
prepared build and bounded executable path on Debian 12, matching Render's documented
native operating system; it does not verify live chain simulation or a fresh network
`npm ci` against a Render service.
The current machine is macOS ARM64; no live Render build, service setting or publish
was exercised by this preparation. Real provider credential/fee qualification remains
an operator prerequisite, and rendered mobile tests do not prove phone authorization.

Optional read-only upstream/fork tests use `EARN_TEST_ANVIL_PATH` with
`EARN_TEST_ETHEREUM_RPC_URL` or `EARN_TEST_ROBINHOOD_RPC_URL`. Their known public test
wallets are funded only inside disposable local forks, never on the origin chain.

References: [Render native runtimes](https://render.com/docs/native-runtimes),
[build/pre-deploy/start behavior](https://render.com/docs/deploys),
[Node version selection](https://render.com/docs/node-version).

## Exit valuation freshness

Exit snapshots read only the investment wallet, including vault shares and wrapped
ETH. Current chain balances and refreshed native return receipt/credit reconciliation
retain their one-minute freshness boundary. Valuation prices allow at most five
minutes, matching the USDG return policy, with at most five seconds of future skew.
The response preserves each provider `priceUpdatedAt` value and declares
`priceMaxAgeMs: 300000`; it never replaces an older price timestamp with the fetch time.
Snapshot expiry is the earliest of the chain reference plus one minute, oldest
required price plus five minutes, and observation time plus one minute.

The [official token schema](https://docs.intents.aurora.dev/api-reference/swap-api-reference/get-supported-tokens.md)
describes numeric USD prices, string update timestamps and optional token contracts.
A read-only credential-free request to `https://intents-api.aurora.dev/api/tokens/`
on 2026-09-30 verified the Ethereum USDC, Monad USDC, Robinhood USDG and native
Ethereum ETH metadata. Native ETH omits `contractAddress`; the three ERC-20
contracts and all decimals matched the pinned registry. Production uses the
configured server key; credential-free listing does not qualify key settings or fees.

Public samples, including cache-bypassing requests, had price ages of approximately
65–107 seconds. The documentation publishes no guaranteed price update cadence.
The five-minute limit is an application validity bound, not a provider freshness SLA;
older or inconsistent prices still prevent a completion result.

## Generated unsigned payout deadlines

The provider may generate an ERC-191 transfer message with a multi-day deadline
even when the approved quote expires within ten minutes. Fresh payout preparation
first rejects duplicate/unknown fields and verifies the signer, private token, exact
amount, deposit receiver and canonical 32-byte nonce. It then narrows only the unsigned
message deadline to the earlier of its original deadline and the verified quote,
request and inactivity expiry. It does this before computing payload/quote hashes or
creating the recovery envelope and native journal context. Already-bounded payload
bytes are retained exactly. Signed submissions, recovered records and retries never
call the narrowing helper; they continue to require the exact approved signed bytes.

The [official Aurora ERC-191 signer](https://github.com/aurora-is-near/intents-swap-widget/blob/357e9447aaa774f1f89c6d5684065c4b11012977/packages/intents-connect/src/signers/standards/erc191.ts)
signs the caller's message verbatim. The [primary NEAR Intents engine](https://github.com/near/intents/blob/a80379014db185e4a2d2d2b45beffe0f96cae31d/contracts/defuse/core/src/engine/mod.rs)
checks the deadline extracted from that signed payload and rejects an expired
message; a versioned nonce requires the signed deadline to be no later than the
nonce's own deadline. Narrowing fresh unsigned authority preserves that bound.
No documented generator deadline parameter was found, and the API does not invent
one. Native deadline limits, protected nonce uniqueness and normal 2-basis-point
provider fee qualification remain required.

## Legacy authenticated history access

Old signed journals without balance snapshots still require authenticated history for reconciliation. The key returned an invite-only denial in a read-only October 12 probe. Ordinary native balance-delta settlement has no such entitlement dependency; better execution above the estimate needs the exact-history exception described above and remains unverified if that access is unavailable.
