# Shared private-balance read session

Approved in chat: unlock once; retain read access across ordinary app switching;
revoke on screen lock, explicit wallet lock/sign-out, wallet identity change or
process restart. All spending remains separately authorized per operation.

Use the existing in-memory Android `PrivateUsdcRead` grant for Home, Earn balance
reads, payout reconciliation and cashout preparation. Remove the separate timed
read grant. Backgrounding still cancels network work and spending approvals, but
does not clear the read grant. Screen-off and device-lock checks clear it.
Short-lived empty-intents RPC authentication and quote freshness remain unchanged.
Feature-level cancellation cancels operation authority without invoking explicit
wallet lock. Older native builds may safely fall back to full lock.

The alternative of extending read timers was rejected because it retains multiple
permission owners and eventually repeats the unlock. Persisting permission across
app restarts was rejected because the approved session ends on restart.

When locked, show “Unlock private balance.” When authorized, refresh automatically
on return and retain only quiet manual refresh controls where useful. Authentication
copy must not imply every refresh needs a passkey.

Scope: connected Android app plus shared React Native UI. iOS has no equivalent
private portfolio/deposit implementation; do not add unsupported capabilities.
Keep the current dirty checkout and all prior work. Do not deploy or push backend
changes, approve a spending prompt, or clear device data.
