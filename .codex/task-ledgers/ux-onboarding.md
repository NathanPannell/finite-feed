# Onboarding UX

## Goal and success condition

Complete issue #53 with reversible saved-answer navigation, clear progress and review, inline validation, reliable Telegram connection choices, responsive layouts, and tests that exercise the existing backend invalidation contract without live model or Telegram calls.

## Completed

- Added named seven-stage progress, saved-stage state, Back on steps 2–7, hydrated answer drafts, and a compact editable answer review.
- Kept Back and unchanged-answer traversal local. Changed upstream answers use existing API invalidation and preserve downstream local drafts until they are explicitly resaved.
- Prevented stale profile acceptance and stale delayed navigation with accepted-profile handling, busy control locks, and navigation-epoch checks.
- Added inline open-response, profile, weekday, and IANA timezone validation. Valid browser aliases are canonicalized for Python `ZoneInfo`; numeric offset IDs are rejected without replacing the input.
- Replaced profile approval `Okay` with `Use this profile`; demoted unavailable Email/SMS delivery.
- Replaced the asynchronous Telegram popup with an explicit deep link, manual six-digit code, actual expiry time/state, replacement-code action, and dashboard-only completion. Direct-link 401 responses return to sign-in.
- No backend changes, live model calls, production writes, Telegram sends, or token logging.

## State-machine decisions

- `PUT /answers` clears later persisted answers, open response, synthesized/accepted profile, delivery, and completion only when an answer changes.
- `PUT /open-response` clears synthesized/accepted profile, delivery, and completion only when the response changes.
- Local drafts remain available after invalidation, but profile review uses only the current server `draft_profile`.
- An already accepted profile is revised through upstream answers because the incomplete-session profile endpoint does not allow replacing an accepted version directly.

## Verification

- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm run build`: pass, 14 routes generated.
- `npm run test:proxy`: 14 passed, 0 failed.
- Existing onboarding behavior subset in `signal-surfaces.spec.ts`: 4 passed, 0 failed on `PLAYWRIGHT_PORT=3197`, 2 workers.
- New `onboarding-ux.spec.ts`: 7 passed, 0 failed on `PLAYWRIGHT_PORT=3197`, 2 workers. Covers back/change/reload, retained retry drafts, held synthesis locks, timezone alias/offset behavior, day validation, manual code expiry/regeneration, explicit deep link, completion retry, dashboard-only completion, and Telegram-link 401.
- Impeccable layout detector: no findings.
- Reviewed fixtures with no document overflow and the current mobile stage kept in view:
  - `frontend/test-results/onboarding-ux/desktop-telegram.png`
  - `frontend/test-results/onboarding-ux/mobile-390-profile.png`
  - `frontend/test-results/onboarding-ux/mobile-320-delivery-error.png`

## Remaining

- Root agent will integrate this commit with the other issue branches, run the combined suite, push, and create the PR.
