# Telegram improvements

Goal: make queued Telegram recommendations immediate, confirm conversational preference additions, include thumbnails, and support secure manual six-digit account connection while preserving deep links.

Success: queue consumption/refill contracts are wired; preference changes invalidate/refill; confirmation callbacks are bound, expiring, superseding, and replay-safe; manual codes are short-lived and single-use; meaningful tests pass.

Decisions:
- Migration `0016` is reserved here; queue owns `0015`.
- `POST /api/account/telegram-link` keeps `url` and adds `code` plus `expires_at`.
- A six-digit private message is consumed as a link code before linked-user lookup.

Completed:
- Added migration `0016` for typed link credentials, durable attempt windows, and durable preference confirmations.
- Added six-digit issuance/consumption alongside preserved deep links, account-bound queue warming, unlink/delete cleanup, and five-attempt-per-minute manual-code limiting.
- Added queue-only `/recommend` delivery, immediate two-slot consumption, durable refill requests, account-before-queue lock ordering, and send-error-only cooldown behavior.
- Added thumbnail `sendPhoto` delivery with bounded UTF-16 captions and bounded confirmation messages/callback data.
- Added append-only confirmation callbacks bound to account/chat/sender with expiry, supersession, rejection, replay safety, and queue invalidation after preference or feedback changes.

Evidence: targeted unit and PostgreSQL integration selection passed, 31 tests; `git diff --check` found no whitespace errors.

Quality follow-up:
- Preference prompt send stays inside the dedupe transaction, so a failed send rolls back and the same Telegram update can retry; ambiguous acceptance remains deliberately at least once.
- Worker cleanup globally removes manual-code attempt windows after 24 hours and resolved/expired confirmation text after 30 days, even without model configuration.
- Retained confirmations are included in account export; unlink and deletion remove directly associated ephemeral state.

Evidence: expanded targeted PostgreSQL selection passed, 52 tests; independent quality re-review passed its 10-test combined selection and closed both findings.

Next: root runs the final full backend suite.

Integration milestone: Builders passed frontend lint/typecheck/build and all 19 browser tests (desktop/mobile visual QA); queue and Telegram targeted PostgreSQL suites passed. Both migrations apply and rerun cleanly. Full backend run: 175 passed, three setup errors from Windows default pytest temp-folder permissions; rerunning only those with a repository-local temporary directory. Independent quality review active. No live Telegram messages sent.

Verification: All 178 backend tests passed across the main run and the three temp-directory reruns; five offline recommendation evaluation cases passed. Frontend lint/typecheck/build, 19 E2E tests, 13 proxy tests, and six deployment utility tests passed. Desktop/mobile onboarding visually checked. Independent review remains active; draft PR will start CI and isolated preview deployment.

Review milestone: Resolved orphaned generation recovery, scheduled batches above two, failed confirmation prompt retry, and bounded temporary-record retention/export. Independent reviewer rechecked the fixes with passing targeted tests. Final complete backend suite: 183 passed (one upstream deprecation warning). Initial PR39 CI and full-stack preview passed at 52d1622; pushing reviewed fixes and awaiting refreshed CI/preview for final browser verification.

Complete: PR39 is ready for review: https://github.com/NathanPannell/finite-feed/pull/39. Final head eca92b00cc101e03701570c9ac33ca43fa54e9c3 passed backend/frontend CI and full-stack preview. /ready matched head and 18 migrations, with the new exact frontend CORS origin. Browser inspected final deployed settings route and expected signed-out gate; no browser warning/error logs. Direct unauthenticated preview HTTP is protected by Vercel SSO. Authenticated linking was covered with local fixture browser tests; no live Telegram messages were sent. Independent review has no remaining material findings. Isolated test PostgreSQL container stopped. Completion evidence recorded locally after the reviewed code commits to avoid another deployment for ledger-only changes.

Regression 2026-09-06: User reported Google redirect_uri_mismatch on PR39. Traced prior task history and BETA_OPERATIONS: each new Neon branch requires its own Google callback. Prior verification stopped at signed-out UI despite documented external gate. Reproduced real Google error and compared configured OAuth redirect list; PR39 callback absent. Added exact PR39 Neon Auth callback in existing Google client, preserving existing URLs and credentials. Repository OAuth-start deployment guard being implemented; live sign-in retest active.

OAuth regression resolved live: Google saved exact PR39 callback and sign-in returned to authenticated feed/settings; browser warnings/errors empty. New deployment OAuth-start validator tested with registered callback (302 sign-in) and deliberately unregistered callback (302 OAuth error), plus 14 passing script tests. Independent focused review active before commit; no app-code or credential changes required.
