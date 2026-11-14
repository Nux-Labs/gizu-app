# Historical full-stack AWS deployment proposal

**Status:** superseded proposal, retained for architectural context. The
5 November 2026 Lightsail/GHCR/SSH design below is not the current deployment
procedure and does not describe deployed resources.

The website implementation follows the [landing S3/CloudFront plan](LANDING_AWS_DEPLOYMENT_PLAN.md)
and [delivery tooling](../../deploy/landing/README.md). Backend build/release
instructions now use [Docker, CodeBuild/ECR and ECS/RDS](../app-guide/AWS_BACKEND_DEPLOYMENT.md).
Production clients target `https://api.gizu.io`. No account inventory, DNS changes,
pipeline enablement or live migration was performed by this documentation review.

## Original rationale and choices

The November proposal sought a production-facing hackathon deployment with limited
AWS credits. It accepted a single-server failure domain and brief deployment
downtime to reduce ongoing cost and operating scope. These were proposal choices,
not current infrastructure requirements:

| Component          | Historical choice                                                     | Current interpretation                                                                                                |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| App host           | Lightsail Ubuntu 24.04 LTS x86-64, 2 vCPU / 4 GB / 80 GB in Frankfurt | Not provisioned by checked-in tooling; backend container/release guide uses ECS                                       |
| Database           | Separate encrypted Lightsail PostgreSQL Standard tier, no HA standby  | Current backend guide targets RDS PostgreSQL 18; actual database state is unverified                                  |
| Landing            | NGINX serving the same `landing/dist` at apex and www                 | Superseded by private S3 + CloudFront + ACM tooling                                                                   |
| Frontend           | Separate `frontend/dist` root at `app.gizu.io`                        | Remains separate from landing tooling; no frontend AWS delivery workflow is supplied                                  |
| API                | One Fastify process behind NGINX at `api.gizu.io`                     | Domain retained; container guide uses an HTTPS load balancer                                                          |
| Images and release | Private GHCR, automatic passing-main release over SSH                 | Not implemented; backend GitHub workflow validates images, while the AWS guide describes manual CodePipeline releases |
| Secrets            | Restricted host files plus a protected recovery copy                  | ECS guide uses runtime environment and Secrets Manager references                                                     |
| Infrastructure     | OpenTofu and manually reviewed applies                                | Implemented for landing only; no checked-in Lightsail or backend ECS/RDS resource definitions                         |
| Monitoring         | Basic metrics/alerts, external uptime checks, rotated logs            | Still deployment responsibilities; repository code does not prove they are configured                                 |

The old estimate quoted USD 24/month for the app host and USD 30/month for the
encrypted database, before credits/taxes/extras. These are historical estimates,
not current prices, an approved budget or an estimate for ECS/RDS/CloudFront.
Confirm actual pricing, credit eligibility/expiry, owner and a gross spending
ceiling before creating paid capacity.

## Original topology illustration

The original diagram is retained as historical context. It depicts the superseded
Lightsail proposal, including its proposed delivery path.

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

## What changed in the repository

| Earlier assumption                                   | Source evidence now                                                                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container packaging is new work                      | `backend/Dockerfile` builds from the repository root, checks types/tests, pins Linux AMD64 Anvil, installs system/RDS CAs and runs as `node`                                                       |
| Shutdown is not wired                                | `server.ts` registers `shutdown.ts`; SIGTERM/SIGINT drain Fastify resources with a 20-second deadline                                                                                              |
| Quote/replay/recovery authority is all process-local | `buildApp` uses PostgreSQL operation coordination, encrypted recovery object persistence, upload admission and minimum-return receipts; caches and capacity/rate limits can still be process-local |
| Native hosted URLs point to Render                   | Current native hosted endpoints and EAS profiles use `api.gizu.io`; installed old binaries or saved records may retain an old gateway                                                              |
| Frontend automatically uses the new API              | `frontend/src/apiUrl.ts` still has a legacy fallback; explicitly build with `VITE_API_URL=https://api.gizu.io`                                                                                     |
| Signup CORS excludes `app.gizu.io`                   | The early-access route now allows apex, www and app origins; this is route-scoped, not global CORS                                                                                                 |
| Landing artifacts might omit hidden associations     | The landing workflow packages canonical association JSON and uploads artifacts with hidden files included                                                                                          |
| All main pushes deploy the backend automatically     | The backend GitHub workflow runs checks/container smoke only; CodePipeline trigger/release configuration is external to the repository                                                             |

The old instruction to add an SSH deploy script or GHCR registry is not required
by the current backend procedure. Do not create that parallel release path merely
to complete this historical plan.

## Constraints that still matter

- Keep RP ID `gizu.io`, iOS bundle `io.gizo.ios` and canonical Android package
  `io.gizu.android`, preserving existing installation identities. Publish approved
  association JSON directly on the RP domain even when it serves the landing site.
- Preserve the stable `EARN_GATEWAY_RECOVERY_KEY`, authoritative database and all
  recovery/coordination/receipt records across releases and migrations. Backups
  must cover the data and the separately protected server key. Client wallet
  ciphertext remains client-encrypted.
- Qualify the actual database version, schema permissions, connectivity, verified
  TLS and restore procedure. Local Compose uses PostgreSQL 17; container smoke
  checks use 18. Neither establishes a successful production migration.
- Anvil installation is Linux x86-64 only. Two concurrent forks each have a 1 GiB
  virtual-memory ceiling; size the service for Node and other overhead too.
  Multiply process-local capacity limits during task overlap or scaling.
- `GET /v1/health` checks the database, not Anvil/provider readiness or settlement.
  Test lifecycle and in-flight recovery on the selected runtime. Shared guards
  prevent replay but cannot reconstruct every unsigned quote cache.
- A code rollback cannot reverse financial operations or database writes. After
  writes move, a stale old database is not a safe rollback target. Inventory
  installed clients and pending operations before retiring legacy hosts.
- Keep provider keys out of application bundles/build arguments, restrict direct
  API/database ports, and verify the ingress's one-hop forwarded-IP boundary.

Use the active [backend guide](../app-guide/AWS_BACKEND_DEPLOYMENT.md),
[runtime reference](../internal/BACKEND_RUNTIME.md),
[recovery persistence contract](../../backend/docs/wallet-recovery.md) and
[landing procedure](../../deploy/landing/README.md) for current commands. Current
cloud resources, budget, backups, release triggers and public routing must be
verified by their operators; this historical proposal is not evidence of them.
