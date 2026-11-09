# Landing page AWS deployment

Implementation of the approved [landing-only plan](../../docs/feature-plans/LANDING_AWS_DEPLOYMENT_PLAN.md).
Branch: `deploy/landing-page`. This directory deploys `landing/` at `gizu.io`
and `www.gizu.io`, with no hostname redirect between them. Infrastructure applies,
DNS changes and publication have **not** been performed by adding this code.

## Resources and boundaries

| Root | Resources | State key |
| --- | --- | --- |
| `infra/bootstrap` | Private, AES256-encrypted, versioned S3 state bucket with TLS-only access and cleanup of old state/lock versions | `bootstrap/terraform.tfstate` after initial local bootstrap |
| `infra/certificate` | DNS-validated ACM certificate in `us-east-1`, covering both hostnames | `certificate/terraform.tfstate` |
| `infra/site` | Private/versioned/encrypted Frankfurt S3 bucket, CloudFront with OAC, cache/security policies and limited GitHub deployment role | `site/terraform.tfstate` |

No server, database, container registry, app/API domain or native endpoint is
created. The existing DNS provider remains authoritative. Check its apex
ALIAS/ANAME/flattening support before applying; CloudFront is addressed by a DNS
name, not a fixed IP to place in an ordinary apex A record. Also inventory current
website routing and CloudFront aliases: existing alias ownership must be handled
under a reviewed cutover procedure, never by silently removing another distribution.

Public nameservers checked on 9 November 2026 are Squarespace's
`nsb1`–`nsb4.squarespacedns.com`. Squarespace documents apex `ALIAS` records and
`www` CNAME records, so a DNS-provider migration is not part of this setup. Its
ALIAS procedure requires DNSSEC to be off: verify the actual domain setting and
delegation before cutover, and do not silently disable DNSSEC if it is enabled.
See [Squarespace's DNS record instructions](https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting).
The same preflight found a published DS record, apex A `216.24.57.1`, no returned
apex AAAA, and www CNAME `gizu-web-app.onrender.com`. These are dated observations,
not records to overwrite automatically. **Apex cutover is pending a DNS strategy
that accounts for this existing DNSSEC delegation.** Keep DNSSEC and current
records unchanged until that strategy is reviewed; never point apex at a transient
resolved CloudFront IP. A CloudFront-hostname preview can be qualified before
public DNS cutover once AWS provisioning is authorized.

The public origin is the S3 REST endpoint, with signed OAC requests. Only `site/*`
is readable through the distribution. `archive/*` and `control/*` stay private.
CloudFront serves `/` as `index.html`; this landing page uses hash navigation.
Missing routes, assets and association files remain errors rather than returning
the HTML page. `/.well-known` files are copied byte-for-byte from the canonical
`frontend/public/.well-known/` source during packaging; **frontend is not built or
deployed**. Both associations are explicitly uploaded as `application/json`.

## Before any resource creation

Assign the cost/recovery owner, monthly gross budget and AWS account. Verify
credits/expiry, current CloudFront pricing mode, S3 costs and expected traffic;
the code creates a standard distribution with `PriceClass_100`, not a flat-rate
subscription or an assertion of free usage. Configure account billing alerts.
Confirm current DNS ownership and preserve the prior host/records for cutover
recovery. Resolve the landing CTA placeholders before enabling public traffic:
The user explicitly selected keeping the existing controls unchanged during this
implementation, with their behavior to be resolved before launch. Join currently
prevents submission and Explore the app links to `#top`.
Docs/X/GitHub footer links also still point at `#top`. No destination is invented
or changed by deployment wiring. Signed-app passkey QA and responsive/link QA
remain launch checks.

Use OpenTofu **1.11.0** and the committed AWS provider lock files. Use a reviewed,
short-lived operator AWS session through the normal SDK environment/profile.
Never place credentials in HCL, backend files, state inputs, GitHub variables or
application bundles. Verify the account with `aws sts get-caller-identity`.
Provider/backend account allowlists guard against targeting another account.
No `.aws` or application `.env` files are read by the local/CI validation path.

## Manual infrastructure procedure

The commands below are instructions for a later reviewed apply, not evidence
that resources exist. Run from the repository root with an encrypted workstation
and restrictive permissions. Each `plan` must be reviewed before its matching
`apply`; do not apply automatically on `main`.

### State bootstrap

```sh
umask 077
cp deploy/landing/infra/bootstrap/terraform.tfvars.example deploy/landing/infra/bootstrap/terraform.tfvars
cp deploy/landing/infra/backend.hcl.example deploy/landing/infra/operator.backend.hcl
# Replace account ID and owner; verify credentials and budget before planning.
tofu -chdir=deploy/landing/infra/bootstrap init -input=false -lockfile=readonly
tofu -chdir=deploy/landing/infra/bootstrap plan -out=bootstrap.tfplan
# Review, then manually apply that exact plan:
tofu -chdir=deploy/landing/infra/bootstrap apply bootstrap.tfplan
```

The initial backend is local because its S3 bucket does not exist yet. Preserve
this local state securely, and use a single operator until migration completes.
Verify bucket ownership, encryption, versioning, public-access block and TLS-only
policy. `state_access_policy_json` is an identity-policy template for approved
infrastructure operators, not an automatic IAM grant. State access is independent
from website deployment access. No DynamoDB table or KMS key is created.

Then migrate bootstrap state explicitly:

```sh
cp deploy/landing/infra/bootstrap/backend.tf.example deploy/landing/infra/bootstrap/backend.tf
tofu -chdir=deploy/landing/infra/bootstrap init -migrate-state -backend-config=../operator.backend.hcl
tofu -chdir=deploy/landing/infra/bootstrap plan
```

Confirm the migration prompt and expect no resource changes. On another operator
workstation, copy the same backend fragment **before** initializing bootstrap;
otherwise it starts locally again. Keep a protected recovery copy of local state
until remote state and locking are verified. Never use `-lock=false` or force-copy
as a setup workaround. Default state history cleanup retains noncurrent versions
for 90 days and at least 20 newer noncurrent versions. Old lock versions expire
after one day; current state and live locks never expire. Review retention before
apply. Grant historical-version recovery permissions separately when needed.

### Certificate, then site

```sh
cp deploy/landing/infra/certificate/terraform.tfvars.example deploy/landing/infra/certificate/terraform.tfvars
# Set verified account/owner.
tofu -chdir=deploy/landing/infra/certificate init -input=false -lockfile=readonly -backend-config=../operator.backend.hcl
tofu -chdir=deploy/landing/infra/certificate plan -out=certificate.tfplan
# Review before this apply:
tofu -chdir=deploy/landing/infra/certificate apply certificate.tfplan
tofu -chdir=deploy/landing/infra/certificate output dns_validation_records
```

Add only the returned ACM validation CNAMEs at the current DNS provider, under
the approved DNS-change procedure. Leave them in place for renewal. Verify the
certificate is `ISSUED`; this step does not switch either website hostname.
The separate certificate state avoids an initial site apply waiting indefinitely
for DNS records that have not been published yet.

```sh
cp deploy/landing/infra/site/terraform.tfvars.example deploy/landing/infra/site/terraform.tfvars
# Supply account/owner, issued certificate ARN and verified GitHub OIDC settings.
tofu -chdir=deploy/landing/infra/site init -input=false -lockfile=readonly -backend-config=../operator.backend.hcl
tofu -chdir=deploy/landing/infra/site plan -out=site.tfplan
# Review resource list, account, access policies and cost before this apply:
tofu -chdir=deploy/landing/infra/site apply site.tfplan
```

Reuse the account's existing GitHub OIDC provider. If none exists, explicitly set
`create_github_oidc_provider=true` and omit the existing ARN after reviewing the
IAM creation. Do not create a duplicate or import an existing provider blindly.
The exact `github_oidc_subject` must match this repository's **main** branch:
legacy `repo:Nux-Labs/gizu-app:ref:refs/heads/main`, or the immutable-ID format
`repo:Nux-Labs@OWNER_ID/gizu-app@REPO_ID:ref:refs/heads/main` when in effect. Verify
the actual repository/organization subject settings before provisioning; the
example records the immutable prefix verified through the repository API on
9 November 2026 (`use_default=true`, `use_immutable_subject=true`). Recheck with
`gh api repos/Nux-Labs/gizu-app/actions/oidc/customization/sub` before apply.
No GitHub environment is attached to
these workflows, because that would change the token subject. The role requires
audience `sts.amazonaws.com` and exact subject equality; PR credentials are rejected.

The deployment role can only list the website bucket, read/write its release
prefixes and create/check invalidations on this distribution. It cannot delete
objects, edit infrastructure/DNS/IAM, or access OpenTofu state. S3, certificate and
CloudFront deletion guards remain active while their resource blocks exist.
Removing an entire block can remove its guard: review all deletes/replacements.
There is no automatic resource or archive cleanup on retirement.

## Artifact and release contract

`release.mjs package DIST OUTPUT FULL_SHA` constructs a bounded artifact with
approved file types, canonical associations and a manifest of paths, sizes,
SHA-256 hashes, content types and cache headers. Symlinks, dotfiles other than
the association directory, traversal, unexpected files, modified contents and
incomplete manifests are rejected. Each bundle is limited to 1,000 files/100 MiB.
Only the bundle is uploaded as an Actions artifact, with hidden files included.

The publisher validates the artifact and the previous release's recovery material
before touching `site/`. It uploads a conditional, write-once archive at
`archive/FULL_SHA/`, completing it with its manifest last. Existing archive writes
are accepted only when actual stored bytes match. It publishes assets before
`index.html`, never deletes older hashed assets, invalidates CloudFront, waits,
and verifies the page and both association responses via the CloudFront hostname.
Only then does it update `control/current.json` with current/previous SHAs.

HTML is cached for at most 60 seconds, associations/other unversioned files for
300 seconds, and hashed Vite assets for a year with `immutable`. CloudFront's
minimum TTL is zero, so those object headers are honored. Uploads are not an
atomic switch across every file/edge. Short-lived overlap can occur, and old
hashed assets stay available for existing HTML. Browser/DNS caches and external
Apple association caching are not erased by a CloudFront invalidation.

On upload/invalidation/response-verification failure after live writes begin, the
publisher makes one attempt to republish/verify the previous archive and restore
its pointer. It still exits with failure if recovery succeeds. First-deployment
failure has no previous release; failed recovery, hard termination, timeout or
lost credentials require operator inspection/recovery. Do not run independent
publishers concurrently. Both GitHub workflows share `landing-production`
concurrency without canceling an active release.

Automatic releases require unchanged association bytes relative to the current
release. A rollback must not remove identities required by installed signed apps.
Association changes therefore stop before live writes and need a separately
reviewed native-compatible rollout; do not bypass this by editing archive hashes.

Archives/live assets are retained; cleanup is not a blind S3 sync/delete or a
time-based archive expiry that could erase the current release. Review storage
growth with the owner and retain at least current/previous release archives and
assets still referenced by cached HTML before any separately authorized cleanup.

## Enable delivery and cut over

Set these repository variables from the reviewed site outputs/account:

| Variable | Value |
| --- | --- |
| `LANDING_AWS_ACCOUNT_ID` | Verified account ID |
| `LANDING_DEPLOY_ROLE_ARN` | Deployment role output |
| `LANDING_BUCKET` | Website bucket output |
| `LANDING_DISTRIBUTION_ID` | Distribution ID output |
| `LANDING_CLOUDFRONT_DOMAIN` | `d…cloudfront.net` output |
| `LANDING_DEPLOY_ENABLED` | Leave unset until launch qualification; then `true` |

No AWS access-key secrets are needed. PRs only build/package/test; main releases
authenticate with GitHub OIDC. Keep the enable flag unset while reviewing code
and preparing infrastructure. For the first approved pre-cutover publication, an
operator can run the publisher with the reviewed outputs in its environment and
an authorized short-lived operator session:

```sh
npm --prefix landing ci
npm --prefix landing run build
node deploy/landing/release.mjs package landing/dist /private/tmp/gizu-landing-bundle FULL_COMMIT_SHA
# Set LANDING_BUCKET, LANDING_DISTRIBUTION_ID and LANDING_CLOUDFRONT_DOMAIN.
# Only after publication authorization:
node deploy/landing/release.mjs deploy /private/tmp/gizu-landing-bundle
```

Use a fresh output path for each package operation. Verify the CloudFront URL,
assets, mobile/desktop layouts, CTA behavior, HTTPS, passkey associations and
rollback. Configure operator Actions failure notifications and an external HTTPS
uptime check. Local tests do not verify live AWS IAM, DNS, propagation or device
passkey access.

Only then, under explicit cutover authorization, update apex and www routing to
the distribution using the current provider's supported records. Preserve other
records and prior hosting. Check both public hostnames, with no www/apex redirect,
and check associations as direct HTTP 200 JSON. Retain the old host through the
observation period. Once satisfied, set `LANDING_DEPLOY_ENABLED=true` for automatic
passing-main releases. Infrastructure applies remain manual.

For a later rollback, dispatch **Landing rollback** from `main` with the full SHA
of a completed archived release. It restores that artifact without rebuilding the
website or modifying DNS. Recovery bypassing the workflow needs the same operator
coordination and release verification; do not manually edit current.json to hide
a failed deployment.

## Verification

```sh
node --test deploy/landing/test/*.test.mjs
npm --prefix landing run build
# For each root, without a live backend or AWS credentials:
tofu init -backend=false -input=false -lockfile=readonly
tofu fmt -check -recursive
tofu validate
tofu test
```

The infrastructure workflow runs mocked plan-only tests for all three roots.
Source/provider locks include Linux amd64/arm64 and macOS arm64 hashes. Existing
landing audit reports four build-toolchain findings (two high, two moderate),
while `npm audit --omit=dev` reports zero at this review. Dependency upgrades are
separate work; no Vite development server or Node runtime is exposed here.

Sources: [private S3 static site](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/getting-started-secure-static-website-cloudformation-template.html),
[ACM certificate region](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html),
[GitHub OIDC subjects](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[OpenTofu S3 locking](https://opentofu.org/docs/v1.11/language/settings/backends/s3/).
