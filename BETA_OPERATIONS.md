# Private beta operations

Owner: NathanPannell. The implementation is intended for a small invited beta. Actual multi-user soak evidence and recommendation-quality claims are tracked separately in #32 and #33; recovery rehearsal and proactive alert delivery are #34.

## Release and identity

GitHub CI applies all checksummed migrations, runs backend integration checks and frontend build/journeys. A PR deploys isolated Neon/Railway/Vercel resources. Check the API `/ready` commit against the PR head before browser verification; repeat against the merge commit in production. Google identity is verified live against the matching Neon Auth branch. Both API and frontend require the same branch-specific `NEON_AUTH_BASE_URL`; only Vercel receives `NEON_AUTH_COOKIE_SECRET`. Logout/revocation must deny the next personal API request. Existing dogfood identity is never claimed by matching email.

Personal routes are `/app` and `/app/settings`; `/match` stays public. Control Room remains behind Vercel SSO plus independently verified Vercel OIDC at Railway. Preview scheduled Telegram delivery stays disabled and production bot credentials are removed. Never change production webhook registration to a preview URL. Preview Connect registers only the developer bot to that preview API, requires an allowlisted tester, and fails without secure webhook configuration. Telegram permits one webhook per bot: the most recent preview Connect owns developer routing, so reconnect in the intended preview before testing. Workers do not register the developer bot or reclaim it; production webhook recovery registers only the production bot every six hours, retrying setup failures after fifteen minutes.

To move an existing dogfood Telegram chat to a new Google account, send `/unlink` and then `/unlink confirm` in the bot's private chat. This pauses the old account, clears its chat link and outstanding link tokens, and preserves its preferences/history. Create a fresh Telegram link in the new Google account's settings afterward. Ownership is proven by the authenticated Telegram chat; email matching never claims or transfers an account.

## Pipeline and budgets

The worker isolates ingestion and delivery stages and each recipient. It records a heartbeat in `worker_heartbeat`; Control Room reports a stale heartbeat after ten minutes. Review ingestion errors, embedding completeness, per-account delivery errors and `provider_daily_usage` before retrying. A missing or stale heartbeat requires checking worker deployment and logs; API `/ready` alone does not prove the worker is running.

`DELIVERY_ENABLED=false` is the delivery kill switch. Change the repository variable and the running Railway worker variable, then redeploy the worker; a later workflow preserves the repository value. Per-account pause is available in settings and Telegram. A provider or database outage should recover through persisted bounded retry; do not clear cooldowns or delete pending recommendations to force repeated sends.

Defaults are 40 model requests and 1,000 YouTube requests per UTC day (`MODEL_DAILY_REQUEST_LIMIT`, `YOUTUBE_DAILY_REQUEST_LIMIT`). All attempts count, including provider failures. Model output is bounded; the pinned free model remains the budget baseline. YouTube calls here use channel/playlist/video endpoints rather than costly search. Preview budgets use its isolated database but provider credentials may share upstream limits, so account for preview traffic when setting caps. Exhaustion waits for the next budget window; do not repeatedly raise limits to hide a failing provider.

Scheduled delivery catches up after the chosen hour on an enabled local calendar day and never replays prior days. Timezone conversion uses IANA zones and local dates, covering repeated DST hours; the configured count caps daily picks. A partial delivery retries only the remainder. Existing model-backed pending picks are reused. Explicit abstention leaves a useful waiting state instead of sending an arbitrary pick.

Telegram `/recommend` consumes one of two durable prepared slots without a model call. A separate worker loop refills consumed, stale, or interrupted slots independently of ingestion, using leases and persisted retry delays. Preference edits and confirmed Telegram additions invalidate both slots; provider budgets still apply to rebuilding them. Initial setup, bursts beyond the available picks, and provider failures can temporarily leave the queue empty. Inspect `telegram_recommendation_queue.status`, `retry_after`, `lease_expires_at`, and sanitized `last_error` when refill stalls; the pipeline heartbeat alone does not prove the queue is ready.

Telegram sends remain at least once in the irreducible case where Telegram accepts the message but the following DB commit fails. Inspect history before manual retry. Preview must never send to production recipients. User linking requires an expiring, single-use account-bound token in a private chat.

## Incident recovery and rollback

Pause delivery first when duplicates, incorrect recipients or unsafe recommendations are suspected. Inspect sanitized logs and the deployed SHA, database migration state, auth endpoint and exact frontend origins. Repair configuration and run the normal workflow; Railway restart reuses an image and does not deploy new code.

Use the last known-good release that supports account authentication for application rollback. Do not roll back to the unauthenticated dogfood API: that would reopen personal data access. If the first account release needs rollback before a compatible release exists, keep personal endpoints unavailable while fixing forward. Additive migrations should remain applied; never edit migration checksums or run destructive schema rollback against production.

Restore into a new isolated Neon branch, verify account separation and record counts, then rehearse the application against it with Telegram disabled. Production database cutover needs deliberate operator review and a current backup. No restore rehearsal or soak is claimed by this release; evidence belongs in #32/#34.

## Retention

Preferences, follows, recommendation evidence and feedback support the account until the user deletes it. Export is available in settings. Account deletion removes personal application records and unlinks Telegram; an identity tombstone prevents a still-valid provider session from silently recreating the account. Shared source/video metadata is retained. Neon identity/session records, provider backups and messages already delivered to Telegram have separate lifecycles; the privacy page explains this boundary. Telegram link-attempt windows are cleaned up after 24 hours; resolved or expired preference confirmations are cleaned up after 30 days. Retained confirmation proposals are included in account export, and account deletion removes them. Do not log auth cookies, link tokens or provider credentials.

## Google OAuth operations

Production and PR35 use a project-owned Google web OAuth client configured directly in Neon. Google must allow each branch's exact `${NEON_AUTH_BASE_URL}/callback/google` URI; a trusted frontend origin in Neon does not replace this Google callback registration. Before testing Google on a new preview branch, register that branch callback in the existing Google client and verify its provider configuration. Keep client secrets in the provider configuration, never in repository files or browser-visible frontend variables. The Next.js auth middleware must exchange the callback verifier before the personal API can receive a session.

The default OpenRouter route tries `google/gemma-4-31b-it:free`, then `google/gemma-4-26b-a4b-it:free`, then `nvidia/nemotron-3-super-120b-a12b:free` inside one request when a provider is unavailable or rate limited. This default route disables optional reasoning to preserve the 350-token JSON response budget. Custom model pins and their reasoning defaults remain exact. Shared account quota exhaustion can still stop every fallback; the app distinguishes daily, minute, and upstream limits without exposing provider payloads, and keeps the persisted request budget.
