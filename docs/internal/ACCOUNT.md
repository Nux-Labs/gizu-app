# Account and notifications (M5)

Source reviewed 2026-11-14. Normal sessions use the native stored-wallet identity,
not the M5 profile fixture. Native access is local and does not create a backend
authentication session. [PARITY](../feature-plans/PARITY.md) owns financial availability;
this page covers account UI, preferences and the retained fixture inbox.

Mainnet Account displays the current funding address with native clipboard copy,
security/support rows, a Display group, full wallet backup and recovery controls,
and Disconnect. Currency and Statements remain protected secondary routes but have
no rows in Settings. Information-page copy can describe narrower historical scope;
it does not override the native capability gates for Swap, Earn or withdrawals.

## Implemented behavior and availability

| Area                      | Outcome                                                                                          | Boundary                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Account details           | Mainnet funding address; testnet Account 0; fixture name/member only in demo tests               | Native identity comes from the session, not the profile fixture                                                                      |
| Copy address              | Native clipboard write with success/failure feedback and retry                                   | Expo Clipboard integration; success shown only after acknowledgment                                                                  |
| Notifications             | Native sessions use an empty inbox; fixture tests support read/unread, mark all, count and retry | No push delivery or trade reconciliation                                                                                             |
| Push alerts               | Save an on/off preference on the Push alerts page; default off                                   | Local preference only; does not request permission, register a device or affect the inbox                                            |
| Currency                  | Fixture USD; native route labels USDC/MON; EUR/GBP/TRY unavailable                               | No FX rates or relabeled balances; financial asset units stay unchanged                                                              |
| Statements                | Save Monthly, Quarterly or On request; default Monthly                                           | Frequency preference only; no scheduled delivery                                                                                     |
| Statement archive/request | Empty archive and disabled request action with explanation                                       | Unavailable until a document service exists; no invented PDFs                                                                        |
| Passkey wallet            | Native method information; backup and recovery controls on Account                               | New wallet requires verified encrypted backup; restore needs the file and original passkey; guardian/extra-passkey setup unavailable |
| Transaction signing       | Information about separate native review/passkey approval; fixture review in tests               | The information page is not a signing-policy editor or capability authority                                                          |
| Contact desk              | Channel availability information                                                                 | Messaging, callback booking and email destination unavailable; nothing is sent                                                       |
| Terms/disclosures         | General risk information                                                                         | Agreement, risk, privacy and fee documents unavailable until approved publications are supplied                                      |
| Disconnect                | Clear this account's preferences, then end the session                                           | Unmount clears inbox, ledger, snapshots and protected navigation; no remote credential revocation                                    |

The static inbox intentionally avoids claims that a current order settled, that a
credential was used, or that a downloadable statement exists. It is not generated
from M4 operations. Operation outcomes remain in Activity and the operation status
flow. Opening an unread notification expands its full text and acknowledges it;
failed acknowledgment leaves it unread. Mark-all sends only unread IDs. Read state
survives screen changes and refresh within the session, but resets on disconnect
or restart. No notification content is persisted.

All secondary pages retain content Back controls, safe fallback to Settings/Home,
protected navigation, large-text wrapping and scroll padding around bottom tabs.
There are no new top navigation bars. Unsupported account pages show a fallback
instead of a blank screen. The notifications deep link is protected while signed out.

Mascot animation is a device-level preference, enabled by default, stored separately
under `gizu:ambient-motion:v1` as `on`/`off`. It pauses decorative animation and is
not account data. This setting updates immediately; persistence failures are ignored.
Disconnect clears account preferences, not this device-level setting or the native wallet.

## Persistence contract

`src/storage/preferences.ts` wraps AsyncStorage 2.2.0. Only this normalized object
is stored under `gizu:preferences:v1:<encoded-account-id>`:

```json
{ "version": 1, "alerts": false, "currency": "USD", "statements": "Monthly" }
```

- `AccountProvider` scopes the key to `session.accountId`; fixture sessions without
  that field fall back to `development-member-0417`. Native session identity comes
  from the access adapter, never from user-entered navigation parameters. It does
  not imply backend authentication.
- Missing, corrupt or unknown-version JSON falls back to defaults. Fields are
  normalized independently; invalid booleans/frequencies default and currency is
  always USD. Unknown fields are never written back.
- A storage read failure does not silently claim saved settings loaded. Editing
  stays disabled until Retry preferences succeeds. Financial screens remain usable.
- Changes are committed to UI state only after a successful write. While writing,
  additional preference changes and disconnect are blocked. Failure retains the
  last committed value, explains the error and allows the same action to retry.
- Explicit disconnect removes only the current account's key, not all app storage.
  If removal fails, the session remains open with a retry message. Late hydration
  cannot restore state after disconnect. This cleanup policy is for the current
  local prototype; real session invalidation must not depend on local storage health.
- Preferences survive process restart until explicit disconnect. Authentication,
  the fixture ledger and inbox do not. Native journals and portfolio caches have
  their own encrypted persistence. The account-preference record contains no key
  material, access tokens, address, profile, notification payload or balance. Other
  non-secret app stores include observed balance history and withdrawal selections.

Feature controllers own loading, mutation guards and stale-result protection.
`AccountProvider` accepts replaceable storage/clipboard adapters;
`NotificationProvider` creates a fresh default mock service for fixture sessions;
`AppRoot` explicitly supplies the empty service to native sessions.
`AppRoot` exposes injection points for functional tests and future integrations.
Primitive components receive values and callbacks without owning feature logic.

## Verification and remaining integrations

Functional tests render real screens, controllers, navigation and providers.
Only storage, native clipboard and service boundaries are mocked. Coverage includes
read/unread/mark-all, empty/loading/failure/retry, preference hydration/write failure,
remount persistence, account-scoped cleanup, duplicate prevention, late results,
copy success/failure and unavailable secondary actions. Native QA is recorded in
[FOUNDATION.md](FOUNDATION.md); Jest does not prove OS permissions or biometrics.

Native passkeys, encrypted backup and original-passkey restore are implemented;
physical-device and recovery acceptance remain separately recorded. Push delivery,
FX, statements, support messaging and published legal documents remain separate
integrations. Completing native access does not enable those controls.

No application or native checks were rerun for this documentation-only source review.
