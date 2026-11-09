# AWS application delivery wiring

This is the first implementation slice of the [AWS plan](../../docs/feature-plans/AWS_DEPLOYMENT_PLAN.md).
It supplies the image, single-API Compose service, host NGINX configuration,
host directory preparation, SSH release transaction and GitHub Actions workflow.
It does not provision AWS resources, migrate data, change native endpoints or
enroll certificates. OpenTofu, the full OS/bootstrap installer, monitoring and
restore qualification remain follow-up work before enabling deployment.

## What runs

The API uses Node 24.15.0 on Debian Bookworm, locked production dependencies,
and the existing checksum-verified Anvil 1.8.3 wrapper. It runs as the unprivileged
`node` user, with an init process, a read-only filesystem, bounded temporary space,
3 GiB memory and 256 PIDs. Only loopback port 3000 is published. Anvil remains
inside the container and binds its own loopback ports. Qualify these limits on
the selected 4 GiB Lightsail instance; they are starting limits, not capacity evidence.

NGINX runs on the host. It serves both sites through `/srv/gizu/current`, copies
approved passkey associations to the landing root via explicit aliases, and
proxies **all** API paths, including `/wallet-recovery/`. It allows the existing
1,398,400-byte recovery request limit and overwrites incoming forwarded IPs.
Access logging is disabled and error logging limited to critical events because
raw paths and queries can contain private data. Application/container logs remain
bounded; configure host log rotation separately.

## Prepare a host before enabling CI

1. Confirm budget/credits and provision the selected Frankfurt x86-64 host and
   private encrypted managed PostgreSQL. Allocate and attach a **Lightsail static
   IPv4 address** before publishing DNS. Preserve that allocation during host
   replacement. OpenTofu/state setup is still required; do not apply infrastructure
   automatically from the delivery workflow.
2. Install Docker Engine, Compose **2.30 or newer**, host NGINX and `flock` using
   reviewed Ubuntu 24.04 installation instructions. Establish an operator account,
   patching, firewall and a dedicated SSH deployment account. Expose 80/443 and
   restrict SSH using the agreed runner/operator access method. Never publish 3000
   or database/Anvil ports. Docker access grants effective host administration;
   this account is trusted release automation, not an untrusted upload account.
3. From a reviewed checkout run `sudo bash deploy/aws/prepare-host.sh DEPLOY_USER`.
   This creates the layout and installs trusted Compose/deploy files, without
   touching backend secrets or activating NGINX. Re-run deliberately when those
   operator-managed files change. Uploaded application releases never replace them.
4. Create `/etc/gizu/backend.env` as root, readable only by root and the deployment
   account's group (0640). Follow `backend/.env.example` and the environment schema.
   Compose reads it as **raw** `KEY=value`: do not shell-source it, quote values or
   escape `$`. Set the real provider credentials and database URL; transfer the
   existing recovery key securely. Never generate a replacement on deploy. Include
   `sslmode=verify-full` in `DATABASE_URL` and install the appropriate trusted CA
   in the image if the endpoint chain is not covered by system roots. Verify with
   the actual `pg` client. CI does not receive application secrets.
5. Provision the dedicated DB schema/role, search path, ownership and narrow runtime
   table/index grants. Inventory **all** tables: cache, early access,
   `earn_operation_coordination`, `wallet_recovery_objects`,
   `wallet_recovery_versions`, `wallet_recovery_capacity`, and
   `wallet_recovery_upload_admission`. Freeze **all** writers for final export,
   restore and verification. Pending authority/claims and recovery revisions must
   survive; copying only signups is insufficient. Reconcile external chain/provider
   state before reopening restored coordination data after PITR.
6. Configure a separate restricted GHCR pull credential for the deployment account
   (`docker login ghcr.io --password-stdin`, using secure local retrieval). Ensure
   the package is private and repository-associated. Preserve rollback images;
   this script never prunes images or releases.
7. Enroll an ACME certificate with SANs for `gizu.io`, `www.gizu.io`, `app.gizu.io`
   and `api.gizu.io`, using certificate name `gizu.io`. The supplied NGINX file
   assumes `/etc/letsencrypt/live/gizu.io/`. Before enrollment, use a temporary
   HTTP-only ACME vhost rooted at `/var/www/acme`; the supplied TLS file cannot
   load until certificate files exist. Configure renewal with a deploy hook that
   runs `nginx -t` and reloads NGINX. Install `nginx.conf` under
   `/etc/nginx/conf.d/gizu.conf`, remove conflicting default sites, run `nginx -t`,
   then reload. DNS/traffic changes still require the cutover checks below.

## GitHub configuration and first cutover

`.github/workflows/aws.yml` validates backend, web and mobile using existing
workflows, builds the Linux amd64 image, executes packaged Anvil offline, and
publishes on pushes to `main`. Web artifacts are built with
`VITE_API_URL=https://api.gizu.io` and retain `.well-known`. Existing Render/default
build behavior and native endpoints remain unchanged. Configure Actions failure
notifications for the named operator; notification delivery is a setup check.

Before the first push, configure repository/package visibility and Actions package
permissions so GHCR stays private. Image publishing happens on `main` even while
deployment is disabled. CI pull requests build/check without registry credentials.

Configure the `production` GitHub environment to allow `main`, without a routine
reviewer gate, and supply:

| Setting | Kind | Value |
| --- | --- | --- |
| `AWS_DEPLOY_ENABLED` | Repository variable | Leave unset until qualification, then `true` |
| `AWS_DEPLOY_HOST` | Variable | Static IPv4 or trusted SSH hostname |
| `AWS_DEPLOY_USER` | Variable | Dedicated deployment account |
| `AWS_DEPLOY_SSH_KEY` | Secret | Dedicated private deployment key |
| `AWS_DEPLOY_KNOWN_HOSTS` | Secret | Operator-verified OpenSSH known_hosts entry matching that host |

Enroll host keys through a trusted operator channel; do not trust `ssh-keyscan`
output from the deploy connection. Configure the deployment key with forwarding,
agent forwarding, X11 and PTY disabled. An SSH forced-command/upload dispatcher
and runner firewall policy still need qualification before production enablement.

Run capacity, private DB/TLS, initial schema creation, restart, maximum-size
recovery upload, stale/duplicate operation rejection, existing-wallet recovery,
signup persistence, external uptime, backup restore, recovery-key retrieval,
certificate renewal and signed-native-build acceptance checks. A health check
only exercises DB connectivity. Do not enable automatic delivery until testers
have compatible builds and the final migration has frozen all writers and
verified the authoritative dataset. Never run funded acceptance without its
separate authorization. No native URLs are changed by this slice.

Once first-cutover qualification is complete, an operator creates
`/etc/gizu/deploy-enabled` and enables the repository variable. Both gates are
required. The next successful main push deploys automatically; neither gate is
a per-release approval. Initial deployment has no previous API to restore.

## Release and failure behavior

CI uploads versioned sites, associations and an immutable GHCR digest into
`/srv/gizu/incoming/COMMIT_SHA`. The installed script validates the release,
holds a host lock, pulls before stopping the only API, drains it via SIGTERM,
starts the candidate and waits up to 90 seconds for health. Both sites and
associations switch through one symlink only after API health succeeds. Static
files remain available during API replacement. Releases with the same SHA are
rejected; use a new commit after failure or perform operator recovery.

On replacement/startup/health failure, stop the candidate and attempt the previous
API **once**, retaining the old sites and reporting failure even if recovery
succeeds. First-release failure or failed recovery needs operator intervention.
The script does not reverse database writes, retry financial operations, perform
schema migrations or restore databases. Changes must preserve rollback-compatible
schemas; destructive changes need a separately reviewed migration/backup procedure.
Preserve the installed Compose file, host secrets, state/api-image and previous
release/image for recovery. SIGKILL/host loss needs manual reconciliation; traps
cannot provide recovery after the host dies.

## Local verification

```sh
docker build --platform linux/amd64 -t gizu-api:aws-local backend
docker run --rm --network none --read-only gizu-api:aws-local /app/.runtime/anvil-v1.8.3/anvil-fork --version
# Linux GNU tools required; tests mock Docker, not release transaction behavior.
docker run --rm -v "$PWD:/workspace:ro" -w /workspace node:24.15.0-bookworm-slim node --test deploy/aws/test/deploy.test.mjs
bash deploy/aws/test/runtime.sh gizu-api:aws-local
```

References: [Compose env-file formats](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/),
[reusable GitHub workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[NGINX request size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size),
[Lightsail static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html).
