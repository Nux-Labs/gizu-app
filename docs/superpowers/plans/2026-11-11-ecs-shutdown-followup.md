# ECS shutdown follow-up to PR #44

Extract the application improvements from #44 into the existing ECR / CodeBuild / ECS deployment. Preserve the current Dockerfile, RDS CA trust and manual CodePipeline release flow.

## Implementation

1. Add a small shutdown handler used by `backend/src/server.ts`. SIGTERM and SIGINT close Fastify once, drain active requests and run existing close hooks. Exit with failure on a close error or after 20 seconds, leaving room inside ECS's default 30-second container stop timeout. Verify with child-process tests for both signals, an active HTTP request, repeated signals, close-hook failure and a hung close hook.
2. Permit exactly `https://app.gizu.io` on the existing early-access endpoint. Carry over its preflight and signup coverage while retaining rejection of unrelated origins.
3. Add a disposable PostgreSQL 18 Docker smoke script for the current repository-root image. Check packaged Anvil, database-backed health and a clean SIGTERM exit. Run it in the existing backend CI and CodeBuild build phase before publishing the image. Never read production secrets or change live infrastructure.
4. Update the ECS deployment guide with shutdown behavior, image checks and actual Amazon Linux build configuration. Run type checks, the backend suite and the real container smoke; request an independent review before pushing.
5. Open a focused PR against latest main. Only after that PR exists, close #44 as superseded and link the replacement.

## Review focus

- The shutdown deadline must not run beyond ECS's default stop timeout.
- Repeated signals must not terminate draining requests or close pools twice.
- Cleanup must run even when the disposable image fails health or shutdown checks.
- A failed smoke check must prevent ECR push and deployment-artifact generation.
- No Lightsail, Compose, NGINX, GHCR or SSH deployment code is carried over.
