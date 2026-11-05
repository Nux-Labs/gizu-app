# Gizu AWS production deployment plan

**Status:** draft for discussion, not an approved architecture or deployment runbook.  
**Scope:** production-facing hackathon project; conserve credits and resources.  
**Reviewed:** 5 November 2026, working tree on `main`, HEAD `0a46f1a`.  
**Owner and monthly spending ceiling:** to assign.

The user confirmed production-first deployment, then clarified that Gizu is a
hackathon project with limited resources and AWS credits that should be used
cautiously. Production-facing means real endpoints and potentially mainnet assets;
it does not imply an enterprise availability requirement.

This revision replaces the earlier managed-service-heavy proposal with a lean
single-server proposal. The cost constraint and single-server availability model
and Amazon Lightsail are confirmed. The selected host OS is **Ubuntu 24.04 LTS**,
OS-only Lightsail blueprint on x86-64. The initial size is Linux x86-64 IPv4,
2 vCPU / 4 GB RAM / 80 GB disk in Frankfurt (`eu-central-1`), subject to capacity
qualification. Website mapping is confirmed: `landing/` at both `gizu.io` and
`www.gizu.io` without a www-to-apex redirect, and
`frontend/` at `app.gizu.io`, with API at `api.gizu.io` for web and mobile
clients. A separate Lightsail managed PostgreSQL database is selected: encrypted
Standard tier, 2 GB RAM / 80 GB storage, advertised USD 30/month base. This replaces
the same-host database proposal; compatible engine version, regional availability,
network/TLS still need verification. Backup strategy is selected: included
seven-day point-in-time recovery plus retained manual snapshots before
destructive changes or database deletion. Manual snapshots are retained for at
least seven days and longer while needed for rollback or database retirement.
Cleanup mechanics and other tooling remain setup work. Routine releases automatically deploy from `main` after
required checks pass; no per-release manual trigger/approval is selected. No resources,
containers, application changes or deployment workflows have been created.

## 1. Lean starting point

Use **one Linux x86-64 application server with Docker Engine + Compose** for the
API and NGINX, plus a **separate Lightsail managed PostgreSQL database**, encrypted
Standard tier, selected by the user. NGINX serves static web files and terminates HTTPS. Keep the existing DNS
provider. Use the selected managed backup/snapshot strategy and minimal monitoring.

| Component | Initial proposal | Why |
| --- | --- | --- |
| Server | Amazon Lightsail, Ubuntu 24.04 LTS OS-only x86-64 blueprint, selected | Initial 2 vCPU / 4 GB RAM / 80 GB disk IPv4 bundle in Frankfurt (`eu-central-1`) selected; credit coverage and capacity evidence remain open |
| Backend | One Fastify/TypeScript container; Anvil children stay inside its runtime | Matches current process-local state and avoids a new distributed architecture |
| Database | Lightsail managed PostgreSQL encrypted Standard tier, 2 GB RAM / 80 GB storage, USD 30/month advertised base, selected | No HA standby selected. Verify Frankfurt availability and a supported engine version compatible with current local PostgreSQL 17 before migration |
| Landing website | Serve the same `landing/dist` at `gizu.io` and `www.gizu.io` through NGINX, without redirecting between them, selected | Public marketing surface; serve the approved passkey association JSON directly at `gizu.io` |
| Frontend | Serve `frontend/dist` at `app.gizu.io` through NGINX, selected | Separate site/root on the same server; current invitation forms move with this build |
| TLS | NGINX with an automatically renewed ACME certificate, such as Let's Encrypt | Avoid a dedicated load balancer; choose certificate tooling during implementation |
| Image storage | Private GitHub Container Registry (GHCR), selected | CI publishes repository-associated images; Lightsail pulls with a restricted credential. Verify package permissions, allowances and cleanup during setup |
| Backups | Included seven-day Lightsail DB point-in-time recovery plus retained manual snapshots before destructive changes or DB deletion, selected | Restore test before cutover; retain manual snapshots at least seven days and longer while recovery-critical. Cleanup mechanics remain open; storage charges apply. No daily S3 export selected; app-host snapshots remain optional |
| Monitoring | Lightsail metrics/email alerts, external HTTPS uptime check, basic host memory/disk checks and rotated local logs, selected | No centralized logs/metrics/dashboard platform initially; contacts, thresholds, uptime provider and log limits remain setup work |
| Host configuration | Version-controlled bootstrap script, selected | Install/configure Docker Engine, Compose, NGINX, users and log rotation; no Ansible initially. Runtime secrets remain outside script/user data |
| Infrastructure management | OpenTofu, selected; review plan then manually initiate apply | Private S3 state with encryption, versioning and native S3 locking selected; execution credentials/bootstrap remain open |

```text
Browser / native app
        │ HTTPS
        v
One Ubuntu 24.04 LTS x86-64 server
  NGINX ───────> gizu.io + www.gizu.io: landing files (no hostname redirect)
     │              gizu.io also serves approved /.well-known JSON
     ├─────────> app.gizu.io: frontend files
     └─────────> one API container
                     ├──TLS──> separate managed PostgreSQL
                     ├──> loopback-only Anvil child processes
                     └──> HTTPS providers and chain RPCs

Managed DB seven-day PITR + retained pre-change/pre-delete snapshot ──> restore target
main + passing required checks ──> CI build/publish to private GHCR ──SSH──> deploy script
```

Expose only HTTPS and, if needed, HTTP for redirect/certificate validation.
Restrict administrative access to the chosen operator method. Do not publish
PostgreSQL, Anvil or the direct API container port to the public internet.
Containers use a private network and dedicated credentials. Verify forwarded IP
handling with the current one-hop proxy setting behind NGINX.

**Not in the initial proposal:** ALB, NAT gateways, ECS/Fargate, Multi-AZ RDS,
backend replicas, Kubernetes, Redis/Kafka, a separate worker fleet or a permanent
staging environment. S3/CloudFront static hosting and additional managed services remain
possible later if usage or reliability warrants them. The separate managed
database is selected now with the non-HA Standard plan; no database standby selected. Nothing from the NUX-DAS
architecture is automatically a Gizu requirement.

## 2. Cost and capacity guardrails

Choose a **monthly gross-cost ceiling before credits**, then confirm credit
eligibility, expiry and excluded services in the actual AWS account. Credits do
not establish that a particular service is covered or that usage is free.

Current published Lightsail Linux/Unix general-purpose IPv4 examples, checked
5 November 2026:

| Bundle | Advertised base price | Capacity role |
| --- | --- | --- |
| 2 vCPU / 4 GB RAM / 80 GB disk | USD 24/month | Selected initial Linux x86-64 IPv4 bundle; qualify capacity before traffic |
| 2 vCPU / 8 GB RAM | USD 44/month | Possible future upgrade only if measurements justify it; not selected |

The 4 GB bundle is selected as the initial size, not proven production capacity.
These are app-server bundle base prices, not all-in account estimates.
The selected encrypted Lightsail managed PostgreSQL Standard plan adds an
advertised **USD 30/month** (2 GB RAM / 80 GB storage), bringing the selected
server + database base to **USD 54/month**, before credits, taxes and extras.
The lower USD 15 database plan lacks encryption at rest and is not selected.
Confirm the engine/tier in Frankfurt before committing spend.
Confirm region-specific availability, taxes, transfer allowances/overages,
snapshot storage, off-host backups, registry storage and provider/RPC costs.
See [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/). Lightsail is
selected; reconsider alternatives only if credit eligibility or measured workload
constraints make this choice unsuitable.

Do not pick the smallest advertised VPS solely for price: the backend permits
up to two Anvil children, each limited to 1 GiB virtual memory. Node,
NGINX and the OS also need room; PostgreSQL is now off-host. Qualify the selected 4 GB bundle with realistic
concurrency; resize only from evidence. Set container resource limits so a burst
of simulations cannot consume all application-host memory. Monitor burstable CPU
capacity as well as nominal vCPU count; sustained simulations can exhaust it.
Changing the application's two-fork limit would be separate code work.

Proposed spending controls:

- One region, one application server and one managed database; no automatic
  horizontal scaling or unreviewed upgrades. Budget the combined USD 54/month
  advertised base, not only the USD 24 app host, plus applicable extras.
- Agree budget-alert thresholds, monitor gross usage as well as remaining credits,
  and assign an owner to react. AWS Budgets notifications can lag charges; they
  are not an instant hard spending cap.
- Use short, bounded log retention and rotate container logs. Bound old image,
  snapshot and backup growth; choose retention rather than leaving everything forever.
- Build application images in CI rather than competing with Anvil on
  the small server. Do not add a self-hosted CI runner to this host.
- Create no second paid environment by default. Use local checks and a temporary
  pre-cutover qualification slot; remove extra resources after use.
- Stop or retire resources after the hackathon only under an explicit operating
  plan. Lightsail instance stop is not a billing cancellation; EC2 storage/IP and
  backup resources can also keep charging. Restore/data preservation comes before deletion.
- Avoid long-term commitments for an experimental project. Review actual usage
  after the first day and first week before resizing or adding services.

References: [Lightsail billing FAQ](https://aws.amazon.com/lightsail/faq/),
[Lightsail CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html),
[AWS Budgets notification delay](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html),
[EC2 instance lifecycle and continuing charges](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html).

**Selected monitoring baseline:** use Lightsail CPU/burst/status and managed
database metrics with email alerts, an independent external HTTPS uptime check,
and basic host checks for memory/disk usage. Built-in instance metrics do not
replace application availability checks or supply every host metric. Keep logs
local with rotation and bounded storage; central collection/dashboards are not
selected initially. Define recipients, monitored endpoints, thresholds, sampling,
log retention/size limits and redaction during setup. Local logs may be lost with
the host; monitoring is detection, not automatic failover or recovery. Billing
alerts remain a separate cost-control requirement.

## 3. Tradeoffs requiring acceptance

**Confirmed availability model:** one server and one API instance. Brief deployment
downtime and manual recovery after server failure are accepted for the hackathon.
Retain persistent data and off-host backups, with restart/recovery checks before
cutover. The application host remains a single point of failure for API and
websites, while managed PostgreSQL has its own failure/recovery behavior. No zero-downtime or automatic host-failover promise is made.
Exact recovery targets and maintenance procedures remain open. Included
seven-day PITR and at least seven-day manual snapshot retention are selected;
retain manual snapshots longer when still needed for recovery.

One API process avoids cross-replica routing but does not make in-memory state
durable. Inventory disposable quotes, portable recovery evidence and state needed
across requests. Before restarting, drain work and verify how pending operations
recover or fail closed. Rolling two API containers temporarily can recreate the
same routing problem as permanent replicas; do not enable overlap by default.

Because the app can use mainnet funds, keep wallet signing boundaries, provider
credentials, the durable recovery key, tested backups and correct passkey hosting.
Lower infrastructure spending does not make these unnecessary. Operator time
for app-host OS patching, TLS renewal and database restore ownership is part of
this proposal's cost; managed hosting does not remove those responsibilities.

## 4. Repository constraints to preserve

| Finding | Required treatment |
| --- | --- |
| Anvil installer is Linux x64 only | Use an x86-64 image/host initially; no ARM selection without a separately verified runtime |
| Node version drift | CI uses `24.15.0`; the Render guide documents `24.19.0`. Choose one reviewed Node 24 patch for build/runtime |
| Backend requires PostgreSQL | Health checks ping it; retain runtime cache/invitation table/index creation in a dedicated application schema with narrow grants, selected. Preserve imported data and verify search_path |
| Process-local quote/recovery/rate-limit records | Prove restart behavior; no autoscaling or overlapping API instances initially proposed |
| Hardcoded Render URLs in native code | Audit Swift, Kotlin, saved gateways and EAS profiles; changing `EXPO_PUBLIC_API_URL` alone does not migrate every call |
| `EARN_GATEWAY_RECOVERY_KEY` | Preserve the existing 64-hex-character key across migration, restart and rollback; protected recovery copy, no routine regeneration |
| Shutdown not explicitly wired in `server.ts` | Verify/add termination-to-`app.close()` handling, child cleanup and pool closure before treating replacement as graceful |
| Associations live in `frontend/public/.well-known/` | Preserve approved JSON through build/artifact transfer and explicitly serve it at `gizu.io`, even though that hostname now serves `landing/`; `landing/` does not contain equivalent source files |
| CI artifacts do not explicitly retain hidden files | Ensure `.well-known` survives artifact transfer; do not blindly upload repository secrets to include hidden files |
| Root README differs from current frontend entry | Use the actual frontend/public invitation experience as evidence; resolve the README's mock-wallet description separately |

`GET /v1/health` confirms a database check, not provider access, Anvil readiness or
mainnet settlement. Cache purge currently runs inside the API; no new worker
service is needed for it. Native apps remain separate signed iOS/Android releases,
not server processes moved to AWS.

## 5. Build, data and secrets

**Selected host setup:** use a version-controlled bootstrap script for Docker
Engine, Compose, NGINX, users and log rotation. No Ansible initially. OpenTofu
creates AWS resources; the bootstrap script configures server software, while
ordinary application releases use the separate SSH deployment script. Keep
provider/database credentials and recovery keys out of launch scripts, user data
and infrastructure state. Handle first-run versus repeat-run behavior and verify
that later bootstrap updates cannot overwrite runtime secrets or destroy data.

The host OS is selected; the backend container base image is a separate build
choice and still needs Anvil dependency/runtime verification. Do not assume host
Ubuntu packages are available inside the container.

Container packaging is new work. Install locked backend dependencies, compile
TypeScript, and install the pinned/checksum-verified Anvil release during the
image build using the existing installer. Retain production dependencies, `dist`,
Anvil and its Bash wrapper. Prove process spawning, wrapper limits, local ports
and teardown in the actual Linux image. Do not download executables at startup.

Run `node dist/server.js` on the configured internal port with
`NODE_ENV=production`; `staging` is not an accepted schema value. Build static
assets in CI. Set `VITE_API_URL` at build time; `EXPO_PUBLIC_*` and `VITE_*` are
public configuration, never places for provider keys.

| Configuration | Treatment |
| --- | --- |
| `DATABASE_URL` | Dedicated application credential to the managed endpoint; private/restricted connectivity and verified TLS/CA/hostname checks with the actual pg client. Do not disable certificate verification or expose the database for CI convenience |
| `MERKL_API_KEY`, `ONEINCH_API_KEY`, `AURORA_API_KEY`, `PIMLICO_API_KEY` | Backend-only, never image/build arguments/static bundles; verify provider access and quotas from AWS |
| `ETHEREUM_RPC_URL`, `ROBINHOOD_RPC_URL` | Treat embedded credentials as secrets; test pinned-block storage reads and full simulation, not only a basic RPC call |
| `EARN_GATEWAY_RECOVERY_KEY` | Secure transfer of existing value and protected off-host recovery; do not print or replace |
| `EARN_ANVIL_PATH` | Image path to the verified wrapper |
| Catalog and fee/legacy policy inputs | Preserve intended configuration; migration is not permission to broaden supported native routes or enable legacy admission |

**Selected backend secret delivery:** restricted host-side configuration files,
excluded from Git, images, build arguments, static bundles and unprotected
backups. Keep an encrypted recovery copy separately from the Lightsail server;
its location, access and restore procedure remain setup work. Preserve the
existing durable recovery key across releases; ordinary deployments must not
regenerate it or overwrite the host secret files. Limit readable files/permissions
and expose only required values to the backend container. AWS Secrets Manager
is not selected initially.

Deployment SSH and GHCR credentials retain their separate CI/server roles; this
choice does not require copying all backend provider keys into CI. Do not expose
AWS credentials to application containers unnecessarily or put secrets into
infrastructure state. **OpenTofu is selected** for version-controlled management
of the Lightsail application server, managed database and related supported AWS
resources. It manages infrastructure, not the application release process.
**Selected infrastructure execution:** review the OpenTofu plan, then manually
initiate the apply. There is no automatic infrastructure apply on `main`.
**Selected state backend:** private S3 with encryption, bucket versioning and
native S3 state locking; no separate DynamoDB locking table is selected. Restrict
state access to authorized infrastructure operators, keep state off Git/the
application host, and protect plan artifacts. Choose bucket/bootstrap procedure,
encryption details, version lifecycle/retention, provider versions, execution
location and credentials during setup. Application deployment from `main`
continues automatically after required checks, independently of infrastructure applies. Sensitive values
can be recorded in state even when CLI output redacts them, so protect state/plan
artifacts and review resource inputs before storing database credentials there.

**Selected deployment transport:** GitHub Actions connects to Lightsail over SSH
with a dedicated deployment key, verifies the server against a trusted pinned
host key and invokes a server-side deployment script. Use a dedicated deployment
account and constrain its commands/privileges during setup; Docker access can
confer host-level privileges. Store the private key only in trusted deployment
secrets, separate from the GHCR pull credential. Host-key enrollment/rotation,
runner network reachability/firewall rules and key rotation remain setup work.
No host polling agent or self-hosted CI runner is selected.

**Selected image registry:** private GHCR. Publish from GitHub Actions using the
repository-scoped workflow token with the required package permissions. Give
Lightsail a separate pull credential restricted to the required private packages;
its secure storage and renewal are setup work. Do not place the publish credential
on the server. Retain exact release image identities and enough previous images
for rollback; account allowances and cleanup policy still need confirmation.

Managed PostgreSQL needs a dedicated role, verified network/TLS connectivity and
a tested managed-backup restore. **Selected schema setup:** retain the existing
runtime cache/invitation table and index creation, with narrowly scoped create/data
permissions in a dedicated application schema. The app must not use the managed
database administrator account. Provision the schema/role and verify search_path
because current queries use unqualified table names. Restore/move existing
signups and required tables into the intended schema without creating an empty
parallel dataset. Test initial creation, restart with existing tables and denied
access outside the application scope. Exact grants and future schema-evolution
procedures remain implementation work; no migration framework is selected.
**Selected backup policy:** use included seven-day point-in-time recovery and
retain a manual snapshot before destructive changes or database deletion.
Deleting the database also deletes automatic backups; manual snapshots persist
separately and incur storage charges. **Selected manual snapshot retention:** at
least seven days, longer while needed for rollback or database retirement. Do
not delete a recovery-critical snapshot just because it has reached seven days;
check dependencies and recovery needs before cleanup. Verify each relied-on
snapshot is complete/restorable. Cleanup ownership/automation remains setup work. Daily PostgreSQL
exports to S3 are not selected initially. Test restore before cutover; a database
backup does not preserve the separately stored recovery key.
The Lightsail encrypted Standard
service/tier is selected; confirm a compatible supported major version before
data transfer. Do not assume local PostgreSQL 17 is offered or that all plans
provide identical encryption, versions or recovery retention. Test restore
and recovery-key retrieval before cutover. An app-host snapshot cannot restore
the separate managed database.

## 6. Domains and native compatibility

**Confirmed website mapping:** the same `landing/` build at both `gizu.io` and
`www.gizu.io`, without redirecting between those hostnames; `frontend/` at
`app.gizu.io`, both served by separate NGINX virtual hosts/static roots on the
same Lightsail server. **Confirmed API hostname:** `api.gizu.io`, shared by mobile
and web clients and reverse-proxied to the single backend. HTTPS must cover both
landing hostnames as well as the app/API hosts. HTTP-to-HTTPS redirects are still
permitted; this decision concerns www-to-apex routing. Configure the web build
and audited native gateway references for
this hostname; selecting it does not update existing clients. Retain the existing DNS provider; do not add
Route 53 or CloudFront solely for this first deployment.

- Preserve RP ID `gizu.io`, iOS bundle `io.gizo.ios` and Android package
  `io.gizu.android`. Changing the API hostname does not require changing wallet identity.
- Serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
  directly as HTTPS 200 JSON at the required domain, without redirects or HTML fallback.
  Preserve approved signing entries and explicitly verify deployed contents.
  Their source remains under `frontend/public/.well-known/`; explicitly publish
  the approved files at `gizu.io` alongside the landing site. Serving them only
  at `app.gizu.io` would not satisfy the existing native RP-domain contract.
- Current invitation CORS allows `https://gizu.io` and `https://www.gizu.io` in
  production, not `https://app.gizu.io`. Add the new frontend origin during
  implementation before moving its forms; verify preflight and persistence.
  Do not assume global API CORS. Preserve any actually required apex/www origins.
- **Selected client transition:** require all testers to update to an AWS-compatible
  native build before cutover. Audit all gateway references and test the matching
  iOS/Android builds; no ongoing Render compatibility endpoint or proxy is selected.
  Keep Render only until pending operations and recovery checks are handled,
  then retire it under the migration/rollback procedure. Its `onrender.com`
  hostname cannot be repointed through our DNS; do not rely on POST redirects.
- Keep old/new gateway recovery and the authoritative signup database consistent.
  Running two backends/databases without a transition plan is not a safe cutover.

Use [passkey hosting](../app-guide/PASSKEY_HOSTING.md) and
[identity configuration](../app-guide/PASSKEY_CONFIGURATION.md). Test existing
wallet access on signed iOS and Android builds; HTTP checks alone are insufficient.

## 7. Lean delivery and migration

1. **Confirm budget and capacity:** manage supported AWS resources with OpenTofu;
   configure protected state and execution credentials before applying. Review
   the plan and manually initiate infrastructure apply; application releases remain
   automatic from `main` after checks.
   Lightsail 2 vCPU / 4 GB / 80 GB IPv4 in
   Frankfurt (`eu-central-1`) is selected; confirm credits, measured memory needs,
   maintenance procedure and who operates the machine.
   Single-server downtime/manual recovery is already accepted.
2. **Build/test in CI:** keep existing backend/web/native checks; produce a pinned
   image plus separate versioned landing/frontend bundles, retaining `.well-known`
   and its explicit `gizu.io` publication. Choose Gizu's
   security scanning rather than assuming NUX-DAS tooling is installed here.
3. **Prepare the host/database:** start from the selected Ubuntu 24.04 LTS
   OS-only x86-64 blueprint; verify actual regional blueprint ID before creation.
   Use the version-controlled bootstrap script for host software/configuration;
   configure OS patching, firewall, Compose, NGINX/TLS,
   managed PostgreSQL network/TLS, protected secrets, log rotation and DB backups. Settle a secure
   supported access method for Lightsail rather than assuming it has EC2
   instance-profile behavior.
4. **Qualify without cutover:** use a temporary isolated slot on the chosen host
   or a short-lived test resource. Check memory with concurrent simulations,
   startup/shutdown, health, providers, invitation persistence, TLS and association
   artifacts. Do not run competing full stacks that exhaust the small host.
5. **Rehearse data transfer:** inventory actual Render database/version/data,
   export/restore and verify schema/signups. Repository docs do not verify live hosting.
6. **Automatically deploy validated main:** changes reaching `main` deploy after
   required checks pass, without a routine manual trigger/approval. Release the
   exact verified image/bundles: prepare recoverable DB state for schema changes,
   drain work, replace the single API process and run health checks. If the new
   API fails startup/health checks, automatically attempt to restore the previous
   working application version once, mark the deployment failed and alert the
   operator even if recovery succeeds. Recovery failure requires manual action.
   Keep static files available when possible. Serialize deployments; do not cancel an active
   deployment/database operation because another CI run arrives. Wire a narrowly
   scoped SSH path from GitHub Actions using the dedicated deployment key,
   trusted host-key verification and server-side deployment script. Do not grant
   a PR runner unrestricted host access.
   First cutover still needs its tester-update, data-transfer and recovery checks.
7. **Cut over:** confirm testers have updated to the verified compatible native
   build before switching traffic. Quiesce signup writes or use a verified
   synchronization method, move authoritative data and update DNS/web config.
   Initial funded acceptance requires separate authorization;
   first verify synthetic/read-only cases.
8. **Observe then retire:** check errors, simulations, passkeys, signups and saved
   operation recovery. Retire Render only after pending operations and recovery
   checks are handled and data/rollback safety is verified. No ongoing old-client
   support is selected; keep any operational transition overlap bounded and budgeted.

**Selected failed-deployment recovery:** one automatic attempt to restore the
previous working API version after new-version startup/health failure, then
manual intervention if recovery fails. No retry loop, database reversal or
automatic resubmission of financial operations. A database/provider outage may
remain broken after application recovery. Health-check timeouts, identifying the
known-working version and notification wiring remain setup work; no broader
rollback policy for smoke tests or later incidents is selected by this choice.

Retain one known-working image, configuration references and both static bundles for
rollback. A code rollback cannot reverse provider orders, chain transactions or
DB writes. After writes move to the new DB, returning to a stale Render DB is
not rollback; define reconciliation first. Document how to restore a lost host
from backup and reconnect it to managed PostgreSQL, and how long that takes.
Never delete the managed database or its recovery material during an ordinary
application update.

## 8. Remaining inputs and verification

| Priority | Decision | Starting proposal |
| --- | --- | --- |
| First | Monthly gross budget and credits | Confirm ceiling, credit coverage and expiry before committing spend |
| First | Capacity and credit qualification | Frankfurt (`eu-central-1`), initial 2 vCPU / 4 GB / 80 GB Linux x86-64 IPv4 bundle selected; verify actual load and credit coverage |
| First | Native cutover qualification | Tester update required before cutover; audit gateway URLs, verify matching builds and handle pending operations/recovery before retiring Render |
| Next | Managed PostgreSQL qualification | Encrypted Lightsail Standard tier selected; verify Frankfurt availability, engine compatibility, restricted connectivity and TLS |
| Next | Monitoring setup | Lightweight monitoring selected; define email recipients, uptime-check provider/endpoints, thresholds, host checks and local log limits |
| Next | Data/secrets/recovery | Host-side secrets/recovery copy and runtime table creation in a dedicated app schema selected; define recovery-copy location/access, exact grants/search_path, snapshot cleanup safeguards and restore target |
| Next | Infrastructure execution | OpenTofu, reviewed/manual apply and encrypted/versioned private S3 state with native locking selected; define bootstrap, IAM, encryption details, version lifecycle, execution location and credentials |
| Next | Delivery and administration | Automatic main deployment, private GHCR and Actions-to-Lightsail SSH selected; define operator access, restricted script permissions, runner connectivity, host-key enrollment and credential handling |

Amazon Lightsail, Frankfurt (`eu-central-1`), the initial 4 GB bundle and the
single-server/single-API availability model and landing/frontend/API hostname
mapping and encrypted Lightsail managed PostgreSQL Standard hosting are decided,
not open questions. Mandatory tester updates before cutover and no ongoing Render
compatibility service are also selected; pending operations/recovery checks must
be handled before Render retirement. Automatic deployment from `main` after
required checks is also selected; no routine manual release gate.
Before enabling traffic, demonstrate restart/recovery, off-host DB restore,
protected recovery-key access, TLS renewal setup, association files, private DB
ports and memory/disk monitoring. Keep the acceptance checklist proportional to
the hackathon; do not add a permanent staging fleet or managed HA services just
to match the earlier proposal.

## References

Repository: [Render deployment](../app-guide/BACKEND_DEPLOYMENT.md),
[backend runtime](../internal/BACKEND_RUNTIME.md),
[environment schema](../../backend/src/env.schema.ts),
[Anvil installer](../../backend/scripts/install-anvil.mjs),
[fork lifecycle](../../backend/src/adapters/earn/fork-simulation.ts),
[API startup](../../backend/src/server.ts),
[PostgreSQL pool](../../backend/src/adapters/postgres/pg-pool.ts),
[web artifact workflow](../../.github/workflows/web.yml),
[frontend API URL](../../frontend/src/apiUrl.ts),
[native gateway example](../../mobile/modules/gizu-stored-signer/ios/Earn/ConfidentialBalance.swift).

Platform: [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[Lightsail FAQ](https://aws.amazon.com/lightsail/faq/),
[AWS Pricing Calculator](https://calculator.aws/),
[hidden artifact files](https://github.com/actions/upload-artifact#uploading-hidden-files).
