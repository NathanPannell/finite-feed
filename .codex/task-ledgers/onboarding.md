# Onboarding PR

Goal: Smooth /app → /login auth entry, dedicated resumable onboarding with three individual choice questions, open prose, LLM profile approval/revision, delivery schedule and Telegram/skip; condensed settings and consistent navigation headings.
Success: Auth-scoped persistent steps/audits, meaningful frontend/backend tests, independent review, PR and deployed-preview browser verification.

## State
- Branch codex/onboarding from origin/main f4a44ef; isolated worktree .worktrees/onboarding.
- Backend worker owns backend/database and tests; frontend worker owns frontend and UI/tests.
- Preserve established design and existing preferences; onboarding dates interpreted as recurring delivery weekdays, matching current scheduler.
- No production writes or Telegram sends; PR preview isolates services and database.
- Root coordinates contracts, integration, independent quality review, PR, CI and preview verification.

## Next
- Integrate worker changes and test evidence; run independent quality review.
- Push PR, inspect CI and exact preview commit, exercise browser journeys.

## Verification plan
- Anonymous /app and settings show no personal shell before /login; expired auth routes back safely; OAuth verifier cookie exchange remains intact.
- Existing customized profiles bypass onboarding; starter profiles enter it; a reload resumes each saved step.
- Three multiple-choice answers and open prose produce one model-backed 2–5 sentence profile; revision retains previous audits; acceptance saves the confirmed profile.
- Recurring local time/weekdays/volume persist; Telegram completion requires real connection, skip works without a token; SMS/email marked coming soon.
- Bad input, unavailable model, stale revisions, and cross-user requests cannot corrupt another account or complete incomplete onboarding.
- Export includes onboarding history; deletion removes personal onboarding content.
- Compact settings and page-specific navigation headings verified desktop/mobile; existing Match Lab/admin journeys remain intact.
- Docker available; isolated test PostgreSQL provisioned at localhost:55441, container finite-feed-onboarding-tests (disposable local data).
- CUA in-app browser works. Existing production browser session is authenticated; inspected only, no account mutations.

## Backend milestone
- Fresh dedicated PostgreSQL migrations through 0015 passed; backend full suite 177 passed (workspace basetemp avoids host temp permissions), targeted suite 33 passed.
- Contract: /api/onboarding GET, /answers PUT, /open-response PUT, /synthesize POST, /profile PUT, /delivery PUT, /complete POST, /audit GET. Personal frontend proxy maps these paths.
- Account includes onboarding_completed. Migration completes customized latest profiles only; starter placeholder and missing profiles remain incomplete.
- Audit order uses sequence; export/deletion include onboarding state and logs; model generation checks current snapshot after quota reservation releases its initial transaction lock.
- Explicit delivery hour/timezone required; weekdays remain 0=Sunday. Step bypass and whitespace validation regressions covered.
- Pending: frontend checks, independent quality review, PR CI and preview.

## Frontend and review milestone
- Frontend lint, typecheck, build, 13 proxy tests and 22 Playwright tests passed; coverage includes no-flash delayed auth, new-account redirect, resumable answers/model retry/profile editing and full Telegram-skip journey.
- Root inspected full six-option desktop/mobile onboarding screenshots; no clipping or horizontal overflow. Captures retained locally under .impeccable/review, excluded from PR.
- Shared masthead replaces app hero headings; canonical /settings retains /app/settings redirect. Google logo and privacy disclosure updated.
- Independent review found and backend fixed scheduler eligibility before onboarding completion, including final send-lock recheck; account deletion now also clears completion timestamp. Targeted worker/pipeline/account tests: 29 passed.
- Deliberate constraint: synthesis requires the configured LLM; failure preserves inputs for retry, without inventing a fallback profile.
- Pending final independent review, PR CI and deployed-browser checks.
