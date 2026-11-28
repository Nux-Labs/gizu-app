# Early access signup

The Join waitlist dialog collects email and consent without a device selector.
The iOS and Android buttons open app-invitation dialogs with the clicked platform
fixed; there is no Both option. These requests are distinguished by source
(landing-hero/footer for waitlist, landing-ios/android for invitations).

The existing Gizu dialog sends email, optional platform, source, consent and consentVersion
(`2026-11-17`) to `POST /v1/early-access`. The API validates the complete landing
payload and adds a server timestamp, `consentRecordedAt`. Older email-only and
questionnaire clients remain supported; their records are not retroactively
marked as consenting to landing updates.

## Configuration

Development defaults to `http://127.0.0.1:3000/v1/early-access`; production defaults
to `https://api.gizu.io/v1/early-access`. Override with `VITE_EARLY_ACCESS_ENDPOINT`
in `.env.local`, or GitHub variable `LANDING_EARLY_ACCESS_ENDPOINT` for CI.
No API key, Tally account or Supabase project is required. The development API
allows localhost and 127.0.0.1 on ports 5173 and 5174; production does not.

For a signup-only local API without wallet/provider credentials, set
`TEST_DATABASE_URL` to your local PostgreSQL database and run
`npm --prefix backend run signups:dev`. It binds only to 127.0.0.1:3000 and
uses the same route and storage adapter as production. Only local database
hostnames are accepted. Run `npm --prefix landing run dev` for the UI.

## Storage and behavior

The existing `early_access_signups` table stores a unique normalized email,
original creation time and JSON preferences. New landing metadata is merged
into preferences, preserving existing questionnaire answers. The consent timestamp
records the most recent explicit consent. No schema migration is needed.
The application DB role still needs the existing schema/table creation permissions.

Only successful persistence returns `{"status":"registered"}`. Duplicate emails
return the same result. Errors remain retryable, and the UI never simulates a
successful save. The existing per-process limiter allows ten attempts per minute
per client IP. Production trusts one proxy hop: verify the actual network path
before rollout; direct public access must not allow spoofed forwarded addresses.
Multiple API instances each have their own limit. CORS is not bot protection.
No signup emails or invitations are automatically sent. The UI does not claim
an unsubscribe feature that has not been implemented.

## Private CSV export

From `backend/`, use a restricted operator database connection in `DATABASE_URL`
(supply it through the approved secret environment, not a committed file):

```sh
npm run signups:export -- /private/tmp/gizu-signups.csv
```

The output must not already exist. It is created with owner-only permissions.
The command reads in bounded batches inside a consistent read-only transaction,
includes consent/source/platform metadata, escapes CSV and neutralizes spreadsheet
formulas. It prints only the count, never email addresses. Failed exports are
removed. Keep CSVs out of Git and public folders and delete them after use.
Legacy records have empty consent fields: do not treat these as new marketing
consent.

## Admin signup view

When the API has an `ADMIN_TOKEN` (at least 32 characters, e.g. `openssl rand -hex 32`),
it serves an operator-only view:

- `https://api.gizu.io/admin/early-access`: table of all signups, newest first
- `https://api.gizu.io/admin/early-access.csv`: same data as a formula-safe CSV download

The browser asks for credentials via HTTP Basic auth: any username, the token as
password. Without a token configured the routes do not exist (404). Responses are
`no-store`, `noindex` and use a restrictive CSP. Store the token in Secrets Manager,
reference it from the ECS task definition like the other runtime secrets, and rotate
it by updating the secret and redeploying. Treat downloaded CSVs as above.

## Verification and rollout

1. Run landing tests/build and backend typecheck, route/export tests.
2. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run
   `backend/test/adapters/pg-early-access.test.ts` to verify persistence, duplicates,
   consent metadata and preservation of older preferences. Tests create an isolated
   schema inside a rolled-back transaction.
3. Review desktop/mobile and keyboard behavior locally against the local API.
4. Deploy the compatible API before the landing build; verify real production
   database access and trusted proxy behavior. Confirm a controlled signup and its
   CSV export, and verify both public landing origins.
5. Keep the existing Tally form available until production verification passes.
   Check its submissions before retiring it; do not silently lose or import them.

Tally and Supabase configuration have been removed from the landing code/workflow.
The external Tally form itself is not modified by these changes.
