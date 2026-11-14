# AWS backend build and deployment

Build the backend from GitHub `main`, store the image in ECR, and run it on ECS
Fargate alongside RDS PostgreSQL. Frontend hosting is managed separately.
The documented release procedure uses CodePipeline's **Release change**. The
repository supplies the Dockerfile/buildspec and GitHub validation workflows;
it does not define ECS/RDS/CodePipeline infrastructure or verify current account
resources, trigger settings, service state or DNS. Confirm those in the target
account before using the provisioning steps below. Production clients use
`https://api.gizu.io`.

## Prerequisites

- Verify the intended AWS account. The checked-in buildspec and ECR policy target
  `381673247521` in `eu-central-1`; this is configuration, not an account inventory.
- Private ECR repository `gizu-backend`, with immutable tags.
- RDS PostgreSQL 18, reachable from the backend security group on port 5432.
- These deployment files must be committed and merged into GitHub `main` before
  AWS can use them. Local changes on another branch are not deployed.

The Docker build context is the **repository root**, not `backend/`. Existing
backend tests read `shared/gas-policy-v1.json` and `shared/swap-targets-v1.json`. The root `.dockerignore` allows
only build inputs and excludes local credentials and dependencies.

## Create the first image using CodeBuild

1. In **CodeBuild → Build projects → Create build project**, name the project
   `gizu-backend-build` and select region `eu-central-1`.
2. Select **GitHub** as the source, connect the repository, and set the source
   version to `refs/heads/main`. Leave webhook/automatic builds disabled.
3. Use a managed Linux **EC2** build environment, **Amazon Linux**, **Standard**,
   **x86_64**, and `aws/codebuild/amazonlinux-x86_64-standard:6.0`. Do not
   choose an ARM or Lambda build environment. Enable **Privileged** mode for
   Docker builds. Start with the small compute size; enlarge it if builds run
   out of memory.
4. Create a new CodeBuild service role. Leave the build outside your VPC: this
   build does not connect to RDS or require production provider credentials.
5. Choose **Use a buildspec file** and enter `backend/buildspec.yml`. This path
   is relative to the repository root. No build environment secrets are needed.
6. For the standalone first build, choose **No artifacts**, and enable
   CloudWatch build logs. The image is pushed directly to ECR; the buildspec's
   `imagedefinitions.json` artifact is used after the project joins CodePipeline.
7. Create the project. In IAM, open the role created in step 4 and add an inline
   policy using [backend/codebuild-ecr-policy.json](../../backend/codebuild-ecr-policy.json).
   This supplements the generated logging/source permissions and grants push
   access only to the backend repository.
8. Select **Start build** and use `refs/heads/main` as the source version.
9. Expect a successful build and one new immutable image in **ECR →
   gizu-backend → Images**. Copy its complete image URI, including the tag.

Every image is tagged with the first 12 Git commit characters and the unique
CodeBuild build UUID, allowing repeated builds of the same commit. The image
label records the full commit. Failed checks or image builds cannot push an
image or generate a successful deploy artifact.

The Docker build runs the existing typecheck and test suite, installs the pinned
Linux AMD64 Anvil release, compiles TypeScript, and runs `npm prune --omit=dev`.
The runtime runs as the `node` user and contains the official RDS
CA bundle plus Debian's system CA certificates. Anvil uses the system trust store
for HTTPS fork RPCs; Node's bundled roots and the RDS-specific `NODE_EXTRA_CA_CERTS`
do not supply trust to the separate simulator process. Without system roots,
deposit previews return HTTP 503 before a review can be approved.
Tests requiring explicitly supplied live providers or disposable
databases remain skipped in the credential-free build.

Before ECR push, CodeBuild runs `backend/scripts/smoke-container.sh` against the
exact local image it will publish. The same check runs in the backend GitHub
workflow. It uses a disposable PostgreSQL 18 instance on an internal Docker
network, dummy credentials and unpublished ports. It verifies database-backed
health, non-root execution, the packaged Anvil wrapper, presence of the system and
RDS CA bundles and a zero exit code after SIGTERM. A failure stops publication. This is
not a live RDS TLS or funded-operation acceptance test.

To run the image check locally from the repository root:

```sh
docker build --platform linux/amd64 -f backend/Dockerfile -t gizu-backend:local .
bash backend/scripts/smoke-container.sh gizu-backend:local
```

## Configure the ECS backend after the first build

Use the newly built image in an ECS Fargate task definition:

| Setting                         | Value                                              |
| ------------------------------- | -------------------------------------------------- |
| Task definition family          | `gizu-backend`                                     |
| Container name                  | `gizu-backend` (must match the buildspec)          |
| Operating system / architecture | Linux / X86_64                                     |
| Initial task size               | 1 vCPU / 4 GiB memory; measure simulation capacity |
| Container port                  | 3000 / TCP                                         |
| Desired tasks                   | 1, with service autoscaling disabled initially     |
| Load balancer health check      | `/v1/health`                                       |
| Application configuration       | Runtime environment and Secrets Manager references |

Use an ECS task execution role with ECR pull/logging permissions and scoped
`secretsmanager:GetSecretValue` access for the secrets referenced by the task.
The CodeBuild role does not need production-secret access.

Transfer the authoritative backend runtime configuration to the task, using
[the runtime configuration guide](BACKEND_DEPLOYMENT.md) as the reference. Inventory
the active service rather than assuming a legacy Render service still holds it.
Preserve `EARN_GATEWAY_RECOVERY_KEY` exactly across replicas and releases, and
preserve wallet recovery objects/versions, shared operation guards and durable
minimum-return receipts along with existing application data. The image already defaults
`NODE_ENV=production`, `PORT=3000`, `EARN_ANVIL_PATH`, and `NODE_EXTRA_CA_CERTS`.

Supply `DATABASE_URL` as a runtime secret using the **RDS DNS endpoint**, a
database role with the required schema permissions, and URL-encoded credentials:

```text
postgresql://USER:URL_ENCODED_PASSWORD@RDS_ENDPOINT:5432/gizu?sslmode=verify-full
```

The included CA bundle enables certificate validation without disabling TLS or
hostname verification. RDS's generated master secret alone is not a complete
`DATABASE_URL`; assemble a separate connection-string secret for the application.
If its password is later rotated, update that connection string and replace the
running ECS task so it receives the new value.

Use the same VPC as RDS. Allow the backend security group into the database
security group on TCP 5432, and allow the load balancer security group into the
backend security group on TCP 3000. The backend needs outbound internet access
to provider APIs and RPC endpoints as well as access to ECR, logs, and secrets.
Configure public-subnet outbound access or private-subnet NAT/endpoints
explicitly; merely placing a task in a subnet does not establish internet access.

On SIGTERM or SIGINT, the API stops accepting new work, drains active HTTP
requests and closes existing application resources. Responses finishing during
shutdown close their HTTP/1 connections instead of leaving ALB keep-alive sockets
open. Repeated signals do not interrupt the drain. Shutdown errors or a
20-second deadline produce a nonzero exit, within ECS's default 30-second
container `stopTimeout`. Keep `stopTimeout` at 30 seconds or greater; this change
does not update a live task definition. Verify longer-running simulations before
changing the shutdown budget.

Configure HTTPS for `api.gizu.io` on the load balancer before directing clients
to the service. Keep the default single-proxy topology when using the app's
current client-IP trust configuration.

Simulation/concurrency limits and some quote caches remain process-local.
Production Earn bindings and one-use submission guards already use shared
PostgreSQL coordination; every replica must share the database and recovery key.
Wallet recovery uploads and minimum-return receipts are also database-backed.
One desired task does not prevent old/new tasks overlapping during deployments.
Verify cached-quote failure/recovery and multiply per-process simulation limits
when sizing overlapping tasks; shared replay guards do not make every cache
portable. See [recovery persistence](../../backend/docs/wallet-recovery.md).

## Add CodePipeline once the ECS service is working

1. Create a custom pipeline named `gizu-backend` in `eu-central-1`.
2. Source: **GitHub (via GitHub App)**, the repository, branch `main`, default
   ZIP output. Set automatic triggers to **Do not detect changes**, or disable
   **Start the pipeline on source code change** (`DetectChanges=false`).
3. Build: **AWS CodeBuild**, project `gizu-backend-build`. Change that project's
   source and artifact types to **CodePipeline** for pipeline execution and
   keep its buildspec path `backend/buildspec.yml`.
   Add artifact-bucket access to the **CodeBuild service role**, too: `s3:GetObject`,
   `s3:GetObjectVersion`, and `s3:PutObject` on the pipeline bucket's objects, plus
   `s3:GetBucketLocation` on that bucket. Its initial standalone role may not have
   these permissions. If the bucket uses a customer-managed KMS key, grant the
   required decrypt/encrypt/data-key permissions on that key to both roles.
4. Deploy: **Amazon ECS** standard deployment, the ECS cluster and backend
   service. Select the **build output** artifact, with image definitions file
   `imagedefinitions.json`.
5. Ensure the pipeline role can use the GitHub connection, run CodeBuild, access
   its artifact bucket, update the selected ECS service, register task definitions,
   and pass the task roles. The console may offer to update the role permissions.
6. Creating the pipeline starts its initial execution even with push triggers
   disabled. Ensure the AWS service is still isolated from production traffic.
7. For subsequent releases, open **CodePipeline → gizu-backend → Release change**.
   A new execution fetches the latest `main` source, tests/builds/pushes it,
   then updates the ECS service with that build's tagged image.

## Verify and migrate

Verify health, chains/catalogs, database writes, provider access, and prospective
Anvil simulations. An empty RDS instance is not a migration of an existing database.
If migrating from a legacy host, rehearse a compatible PostgreSQL dump/restore
from a machine or one-off task with VPC access, verify restored ownership/schema permissions, then schedule a final
write freeze, drain in-flight operations, restore the final dump, and switch
traffic. Retain the recovery key and recovery data throughout. After AWS accepts
writes, do not roll back to a stale database.

Set the frontend build's `VITE_API_URL=https://api.gizu.io` explicitly: its source
still contains a legacy Render fallback. Current EAS profiles and native hosted
endpoints use `api.gizu.io`; installed older binaries and saved operations can
retain prior gateways. Inventory those before retiring legacy hosting. A hostname
owned by Render cannot be repointed through your DNS; any temporary forwarding
service is a separate operational decision, not repository automation.

## Troubleshooting

- **Anvil rejects the platform:** select x86_64 CodeBuild and ECS runtime; retain
  `--platform linux/amd64`.
- **ECR push denied:** attach the scoped policy to the CodeBuild service role.
- **Docker daemon unavailable in CodeBuild:** enable privileged mode on an EC2
  Linux build environment.
- **Buildspec/Dockerfile/shared fixture missing:** check source `main`, buildspec
  path, and repository-root Docker context.
- **RDS timeout:** check VPC, backend/database security groups, endpoint, and port.
- **RDS certificate error:** use the DNS endpoint and `sslmode=verify-full`, and
  retain the image's `NODE_EXTRA_CA_CERTS` configuration.
- **Old code deployed:** inspect the source commit and tagged image in the build;
  release a new pipeline execution rather than retrying an old build or stage.

References: [CodeBuild Docker builds](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-docker.html),
[ECS image definitions](https://docs.aws.amazon.com/codepipeline/latest/userguide/file-reference.html),
[manual pipeline releases](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-rerun-manually.html),
[RDS TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html).
