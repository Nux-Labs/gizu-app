# Private wallet recovery persistence

Production `buildApp` registers the recovery routes against `PgWalletRecovery`
and injects one PostgreSQL-backed `OperationCoordinator` into the native Earn,
Fusion and private payout gateways. No production memory-store fallback exists.
Tables initialize lazily under transaction-scoped advisory locks. The runtime
database role needs schema creation/data permissions; a documentation review does
not deploy the service or migrate an existing database.

## Native-only recovery wire

`GET /wallet-recovery/v1/:id` and `PUT /wallet-recovery/v1/:id` require
`Authorization: Bearer <token>`. Both `id` and `token` are independent native-derived
32-byte values encoded as lowercase 64-character hexadecimal strings. Credentials,
locators and ciphertext stay outside the JavaScript bridge. TLS is required at the
existing deployment ingress.

PUT accepts exactly:

```json
{ "expectedRevision": 0, "ciphertext": "unpadded_base64url_client_ciphertext" }
```

`expectedRevision` ranges from 0 to 2147483646; 0 creates an object. Ciphertext is
canonical unpadded base64url, between 16 encoded characters and 1048576 decoded
bytes. The JSON body limit is 1398400 bytes. GET and successful PUT return exactly:

```json
{
  "version": 1,
  "revision": 1,
  "ciphertext": "unpadded_base64url_client_ciphertext"
}
```

The next write uses the previous revision and authenticates the next revision,
locator and format version inside the client's AEAD ciphertext. Responses use
`Cache-Control: no-store`, including parsing, size, authorization and storage errors.
Missing objects and incorrect/malformed credentials return the identical 404
`RECOVERY_NOT_FOUND`; stale authenticated writes return 409 `RECOVERY_CONFLICT`.
Malformed bodies return 400, oversized bodies 413, unsupported PUT content type
or content encoding 415, storage failure 503, and
aggregate quota exhaustion 507 `RECOVERY_QUOTA_EXCEEDED`.
The server cannot verify AEAD authenticity and has no recovery decryption key.

Persistence stores only the opaque ID, a domain-separated SHA-256 bearer digest,
client ciphertext, monotonic integer revision and server timestamps. A transaction
serializes creation/update per opaque ID, checks authentication and the expected
revision, writes the new snapshot and retains the latest three versions atomically.
Only the latest is exposed. Retention is per object, not per wallet lifetime.
A hard aggregate limit additionally allows at most 4096 objects and 128 MiB of
decoded ciphertext across all retained versions per bearer digest. Authentication
digests intentionally group opaque objects belonging to the same unknown credential
without any user identifier or address. Credential-scoped transaction locks make
quota checks and cleanup atomic across replicas. A quota failure rolls back the
entire write, preserving the previous root; authenticated deletion frees capacity.
No committed backup expires silently.

The native paged implementation can use independently derived
opaque page IDs with this same API. Upload immutable encrypted pages before CAS
publishing the encrypted root manifest; retain all pages referenced by the current
or prior retained root. There is no server-side page relationship, list or user catalogue API.
Authenticated `DELETE /wallet-recovery/v1/:id` removes an object and all its versions;
it returns an empty 204 for present, absent or incorrect-credential objects (the
latter are left intact), preventing existence probes. Storage errors return 503.
Clients must journal newly allocated page IDs durably before uploading, retain
current/prior manifest references, and delete unreferenced and failed-upload pages
after root acknowledgment. Cleanup failure must remain journaled and bounded
before allocating another batch. Never delete pages reachable from retained roots. Never truncate records to fit the object bound. This backend
supports that protocol but does not implement the native page manifest itself.
Known local revision rollback detection and older-backup monotonic merge are native
responsibilities. A new device cannot prove freshness from a malicious server alone.

## Shared temporary Earn guards

The shared coordinator also guards confidential cashout/private funding and
grouped Earn payouts. `earn_operation_coordination` stores only 64-hex HMAC identifiers/commitments,
expiration and creation timestamps. HMAC purposes separate identities from bindings
and existing recovery encryption. Inputs are processed transiently; no addresses,
raw signed data, provider responses or server-decryptable payloads enter the table.
The stable `EARN_GATEWAY_RECOVERY_KEY` supplies the HMAC key with an independent
domain. Every replica must use the same key. Do not rotate it while old signed
authority is valid without a coordinated migration/drain.

PostgreSQL `INSERT ... ON CONFLICT ... WHERE ... RETURNING` atomically binds or
claims authority. Database time controls expiration. A successful claim precedes
provider I/O and stays consumed after transport failure or process crash. Binding
conflicts fail closed. A missing key or unavailable database blocks new sends.
Existing client-held server-authenticated recovery envelopes remain supported and
are separate from the private client-encrypted backup API.

- Native source/return quote identities and recipient commitments live 24 hours.
  Issuance is claimed once. A lost quote response requires its saved envelope or
  a fresh native operation; the server cannot reconstruct an address-bearing quote
  from its commitment. It will not issue another quote for the same tuple.
- Bundler submissions claim chain/sender/nonce for seven days. Duplicates return
  JSON-RPC -32001 and require receipt/by-hash reconciliation. Same-operation nonce
  replay protection ultimately belongs to EntryPoint; this is a bounded submission
  guard, not a permanent on-chain nonce database.
- Fusion binds operation/revision to the order hash and claims each order once,
  through signed deadline plus 24 hours. Repeated/uncertain attempts return 409;
  native must query order status. The backend never reports an uncertain attempt
  as a confirmed successful submission.
- Private payouts bind authenticated actual source credit/cycle and funded role,
  plus generated nonce, for 24 hours. A role can send once through quote expiry plus
  24 hours. A replica retry returns `submissionUnknown`; reconciliation uses the
  original client-held envelope and signed intent. Invalid read authentication
  cannot occupy a durable funding role. A store failure before the first claim
  leaves the exact saved signed record eligible for a later guarded attempt.

Expired coordination rows are removed every five minutes; expiration is also
checked atomically on use. These guards do not replace durable native allocation,
nonce and uncertain-operation journals or authenticated provider/on-chain checks.
Public previews, read-only settlement and receipt/status lookups do not depend on
new-send coordination. Existing process-local maps remain bounded caches and local
rate/concurrency limits; they are not the replay authority in production.

## Logs and verification

Fastify automatic request/error logs are disabled globally, including unknown
routes, to exclude raw path/query values. Private response hooks log only static
route templates, HTTP status and latency. Error and provider sinks use fixed safe
codes/operation labels and never log bodies, authorization, raw errors or provider
fields. Public token/catalogue caching remains unchanged.

Run `npm test`, `npm run typecheck`, `npm run build` in `backend`. Set
`TEST_DATABASE_URL` to an isolated PostgreSQL database to enable the real database
race, restart, retention and opaque-storage tests. Those tests create/drop random
schemas. No production database or live financial transaction is needed.

## Upload admission and service capacity

PUT self-registers a new high-entropy object, so a bearer credential alone is not
resource admission. Production always applies a shared PostgreSQL upload budget
before writing a blob, independent of locator/bearer rotation. Authorization syntax,
opaque-ID syntax, JSON content type, unsupported content encoding and declared
oversize are rejected before body parsing/storage I/O. Canonical ciphertext/body
validation completes before admission I/O. Only a domain-separated HMAC of the
request IP enters the limiter; readable IPs, addresses, bearer credentials and
object IDs are absent from its rows. Counters and timestamps contain no wallet
identity. The stable `EARN_GATEWAY_RECOVERY_KEY` supplies the HMAC key.

Default controls (validated optional integer environment variables):

| Variable                           |     Default | Meaning                                                                         |
| ---------------------------------- | ----------: | ------------------------------------------------------------------------------- |
| `RECOVERY_UPLOAD_CALLS_PER_MINUTE` |        1024 | Accepted PUT attempts per client per database-clock minute                      |
| `RECOVERY_UPLOAD_BYTES_PER_MINUTE` |    67108864 | 64 MiB decoded upload bytes per client per minute                               |
| `RECOVERY_UPLOAD_BYTES_PER_DAY`    |   536870912 | 512 MiB decoded upload bytes per client per 24-hour bucket from first admission |
| `RECOVERY_UPLOAD_MAX_CLIENTS`      |       16384 | Hard maximum number of active HMAC-IP limiter rows                              |
| `RECOVERY_STORAGE_MAX_BYTES`       | 17179869184 | Global 16 GiB decoded ciphertext across all retained object versions            |
| `RECOVERY_STORAGE_MAX_OBJECTS`     |     1000000 | Global maximum number of recovery objects across credentials                    |

These upload defaults admit a 16 MiB/256-page snapshot plus root, including three
such full snapshots per minute behind one NAT. Counts include admitted attempts even
if a later CAS or storage operation fails. Minute budgets reset by PostgreSQL time;
the 24-hour bucket expires from first admission and is never extended by activity.
Expired rows are reclaimed on admission and by five-minute maintenance. A shared
transaction lock makes bucket admission/count/byte updates atomic across replicas;
new client rows cannot exceed the hard table cardinality bound. A missing HMAC key
or unavailable admission store returns 503 before a new upload. Exhausted upload
or bucket capacity returns 429 `RECOVERY_UPLOAD_LIMIT` with no-store. GET recovery
and authenticated DELETE cleanup do not consume upload admission and remain
available when these upload limits are exhausted.

Global capacity is maintained by a singleton PostgreSQL byte/object counter in the
same transaction as each CAS/version retention/delete. Initialization reconstructs
it from existing objects under the same lock. Rotating credentials and IPs cannot
bypass global capacity. An over-capacity write returns 507
`RECOVERY_QUOTA_EXCEEDED`, rolls back the attempted object/revision, and preserves
previous backups. Authenticated cleanup atomically releases global/per-credential
capacity. No backup is evicted or silently expires to admit another client.
This controls logical retained data; PostgreSQL WAL, backups and vacuum/storage
provisioning remain deployment responsibilities.

The production ingress is trusted to terminate TLS, remove untrusted forwarded-IP
headers and supply the actual client address. `buildApp` trusts only its nearest
production proxy hop; direct application access must remain restricted to that
proxy. Changing this deployment boundary requires reviewing client-IP extraction
before enabling uploads. NAT budgets intentionally accommodate normal paged
recovery bursts and can be tuned with the validated knobs above.

Private payout caches now evict expired 24-hour records on entry and after
preparation, reclaiming associated roles, cycles and nonces. Active preparation or
submission keeps its associations until bounded provider work finishes. Client-held
recovery envelopes and shared PG guards remain the recovery/replay authority;
cache eviction does not submit or authorize replacement operations. Regression
coverage fills all 512 slots, verifies capacity rejection, advances time and proves
capacity and credit/nonce associations are reclaimed.
