# Landing-only AWS deployment

**Status:** approved architecture; implementation prepared, not provisioned or published.
**Reviewed:** 9 November 2026.
**Branch:** `deploy/landing-page`, created from `main`.
**Cost/recovery owner and monthly gross ceiling:** to assign before resource creation.

Deploy `landing/` at `gizu.io` and `www.gizu.io`, retaining the existing DNS provider
and serving both hostnames without redirecting between them. The user approved
private S3 + CloudFront + ACM for this narrowed scope. This supersedes the earlier
Lightsail/NGINX website-hosting choice for this phase. Full application/backend
deployment work remains separate; no API, frontend app, database, server, native
URL migration or funded operation is part of this implementation.

## Architecture and contracts

- A private encrypted/versioned S3 bucket in Frankfurt stores live website files
  under `site/`, archived bundles under `archive/`, and release pointers under
  `control/`. Only the live prefix is readable through CloudFront's OAC policy.
- One CloudFront distribution serves both approved hostnames over HTTPS, with the
  default root `index.html`, origin cache headers and no SPA error-to-HTML fallback.
- An ACM certificate in `us-east-1` covers apex/www. External DNS validation is a
  separate stage before website creation/cutover; no Route 53 zone is added.
- OpenTofu manages three roots: protected state bootstrap, certificate and site.
  Applies remain manual after plan review. Public website publication and DNS
  cutover are separate operator steps with their own authorization.
- GitHub Actions builds only the landing application, packages the canonical
  association JSON from `frontend/public/.well-known/`, validates artifacts and
  publishes passing main releases through a narrow OIDC role after enablement.
  PRs receive no AWS credentials. The existing frontend/build workflows remain.
- Release manifests bind SHA, filenames, hashes, sizes and HTTP metadata. The
  publisher archives before live writes, writes HTML last, preserves previous
  assets, invalidates the CDN, verifies responses and updates the current pointer.
  Partial publication attempts one previous-release recovery and reports failure.
  Explicit rollback restores a completed archive without rebuilding or changing DNS.

## Repository evidence and launch inputs

`landing/package.json` builds a static Vite/React site. Current navigation uses
page hashes; there are no browser pathname routes requiring SPA rewrites. Its
Join form only prevents submission, Explore the app points to `#top`, and several
footer links are placeholders. Their launch destinations/behavior need an explicit
choice; deployment does not make signup functional. Passkey associations currently
live in frontend source and must survive apex website replacement exactly.
The user selected keeping these controls unchanged during implementation and
resolving their behavior before launch.

Before creating resources, confirm AWS account/session, budget/credits, operator,
current DNS and apex alias support, current hosting/CloudFront alias ownership,
issued certificate and the repository's actual OIDC subject format. No live AWS
account inventory or paid capacity has been assumed from code validation.
Public DNS preflight found Squarespace nameservers and an existing DNSSEC DS
delegation. Squarespace documents apex ALIAS setup with DNSSEC disabled; the
current records/DNSSEC must remain untouched until a separate cutover strategy
is chosen. Account/operator/budget inputs and that DNS decision remain pending;
the user has not selected an account or authorized a DNSSEC change. These inputs
do not block code/CI validation, but do block provisioning/public cutover.

## Acceptance and rollout

1. Validate format/provider schemas, mocked safety plans, release recovery tests,
   workflow syntax, production build and the complete packaged artifact locally/CI.
2. Review/apply bootstrap manually and migrate its protected local state to S3;
   review/apply certificate, validate DNS CNAMEs, then review/apply the website/IAM.
3. Publish a first authorized release to the CloudFront URL and verify page/assets,
   direct JSON associations, responsive layout, intended links, TLS and rollback.
4. Authorize DNS cutover; serve both public hostnames, preserving other records and
   passkey identities. Verify signed-device access independently of HTTP checks.
5. Observe availability, configure cost/uptime/failure notifications, and enable
   automatic main releases. Preserve prior hosting and recovery material through
   the observation period. Cleanup is separately reviewed and preserves current/
   previous archives plus assets still referenced by cached HTML.

No permanent staging fleet, automatic infrastructure apply, signup backend or
unreviewed content redesign is included. Dependency-tooling audit findings and
manual browser/device/live-cloud checks remain distinct from deployment tests.

Implementation and operator commands: [deploy/landing/README.md](../../deploy/landing/README.md).
