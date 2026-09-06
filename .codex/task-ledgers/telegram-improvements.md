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
