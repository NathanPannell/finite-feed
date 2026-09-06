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

Next: root runs the combined backend suite and independent quality review.

Integration milestone: Builders passed frontend lint/typecheck/build and all 19 browser tests (desktop/mobile visual QA); queue and Telegram targeted PostgreSQL suites passed. Both migrations apply and rerun cleanly. Full backend run: 175 passed, three setup errors from Windows default pytest temp-folder permissions; rerunning only those with a repository-local temporary directory. Independent quality review active. No live Telegram messages sent.

Verification: All 178 backend tests passed across the main run and the three temp-directory reruns; five offline recommendation evaluation cases passed. Frontend lint/typecheck/build, 19 E2E tests, 13 proxy tests, and six deployment utility tests passed. Desktop/mobile onboarding visually checked. Independent review remains active; draft PR will start CI and isolated preview deployment.
