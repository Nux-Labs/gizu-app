
# Gizu web entry

The site served at gizu.io keeps the responsive landing screen and Request access
flow as separate buttons and dialogs. **Test On Mobile** opens an email invitation
form as the recommended first option, followed by self-testing instructions and
links to the repository and mobile setup guide. Self-testing explains how a local
backend/database, configuration, app/API versions, connected services and device
signing can differ from the supported testing environment. **Request access** keeps
its own questionnaire. Both forms
save emails through `POST /v1/early-access`; success appears only after persistence.
The browser entry no longer offers
simulated passkey creation or a mock wallet/dashboard.

Run locally with `npm ci` and `npm run dev` from `frontend/`. Validate with
`npm run build` and `npm test`.

Local development proxies `/v1` to the backend on port 3000. Production defaults
to `https://gizu-app.onrender.com`; set `VITE_API_URL` at build time to override it
(see `.env.example`). Deploy the matching backend before the frontend. The API
allows browser requests from `https://gizu.io` and `https://www.gizu.io`.

Submitting an email joins the invitation list. It does not send an email immediately;
invitations are sent later by the team. No email delivery service is configured here.

Signup requests allow up to 90 seconds for the API to respond, including a slow
backend startup. A timeout reports that signup could not be confirmed; retrying
the same email is safe because the backend keeps one row per email address.

## Retained token discovery components

The retained Swap UI components display a read-only 1inch token catalog for Robinhood Chain
(4663), Ethereum (1), and Monad (143). Robinhood Stock Token contracts are
cross-checked against Robinhood's official `/rhj/assets` API. The RWA filter on
Ethereum and Monad uses the explicit 1inch `RWA` token tag. A token's presence
in the list does not mean a Fusion order can be filled; a live quote for the
selected pair, amount, and wallet is required before adding execution.
The backend serves `GET /v1/tokens` in pages with explicit `chainId`,
`category`, `search`, `page` (zero based), and `items` (1–100) query fields.
The response includes `list`, `page`, `items`, and `total`. The Swap tab loads
60 tokens per page.

These components are no longer mounted by the public web entry. Their backend
integration requires `ONEINCH_API_KEY` in `backend/.env` (see
`backend/.env.example`). The key stays on the backend and must not use the `VITE_` prefix.
