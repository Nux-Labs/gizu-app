# Early access handoff

The landing form is ready for a Supabase Edge Function. No database, project or
live connection is provisioned by this change. Email addresses are not stored
in browser storage. An unset endpoint displays an honest retry message, never
a simulated successful registration.

## Connect

1. Create the table using `supabase/early_access.sql` in your Supabase project.
2. Implement and deploy a server-side Edge Function with the contract below.
3. Copy `.env.example` to `.env.local`. Set `VITE_EARLY_ACCESS_ENDPOINT` to
   `https://<project>.supabase.co/functions/v1/early-access`.
4. If your function gateway needs an `apikey`, set
   `VITE_SUPABASE_PUBLISHABLE_KEY` to a **public/publishable** key. The client
   sends this as `apikey`, not as an authenticated user's bearer token. Configure
   the unauthenticated function's gateway/JWT verification accordingly.
5. For the AWS workflow, set GitHub repository variables
   `LANDING_EARLY_ACCESS_ENDPOINT` and, if used,
   `LANDING_SUPABASE_PUBLISHABLE_KEY`. The build maps these to the public Vite
   variables above. Trigger a new landing build after changing configuration.

Never put a service-role or secret key in a `VITE_` variable. The Edge Function
owns database access. Anonymous clients have no direct table access.

## HTTP contract

`POST` JSON:

```json
{
  "email": "you@example.com",
  "platform": "ios",
  "source": "landing-hero",
  "consent": true,
  "consentVersion": "2026-11-16"
}
```

`platform`: `ios`, `android`, `both`.
`source`: `landing-hero`, `landing-footer`, `landing-ios`, `landing-android`.
Server validation must trim/lowercase the email, check its length/format,
require consent and validate the enumerated fields. Do not trust client input.
Upsert by normalized email so retries or repeated signups do not create duplicates.
Return the same response for new and existing emails to avoid exposing membership.

Only after persistence succeeds, return HTTP 200/201:

```json
{ "status": "registered" }
```

Use HTTP 400 for invalid input, 429 for rate limits, 5xx for unavailable service.
The frontend times out after 20 seconds and permits retry; account for uncertain
responses with the unique email constraint. A cancelled browser request can still
have been saved by the server. Do not log email bodies in application logs.

Allow `OPTIONS` and `POST` from the actual landing origin (and explicitly
configured local development origins). CORS must allow `Content-Type` and
`apikey` when used. Add server-side rate limiting and any anti-abuse measures
before opening the form publicly. No messages are sent by this frontend.

## Verify

Run `npm test` and `npm run build`. Exercise valid/invalid emails, consent,
platform selection, duplicate signup, pending/double submission, backend failure,
rate limits, Escape dismissal, keyboard focus restoration and mobile layout.
