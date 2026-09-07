# Issue 54 — Match Lab judgment UX

## Goal and success condition

Make Match Lab a clear single-choice review on desktop and 320–390px screens while preserving save, retry, debug-assessment, and next-pair behavior. Success requires native radio keyboard behavior, compact evidence beside reachable controls, an actionable completion state, focused Playwright coverage, and all requested frontend checks passing.

## Decisions and assumptions

- Preserve the existing Signal Paper visual language and three-part evidence/judgment structure.
- Use native radio inputs for one-choice semantics and browser keyboard behavior.
- Keep mobile content in DOM reading order: viewer, video, judgment; compress context rather than overlay controls.
- Keep all production data untouched; browser tests use intercepted synthetic responses.

## Evidence

- Issue: https://github.com/NathanPannell/finite-feed/issues/54
- Baseline: `25cbfa9c90daec2d8d5a3485ca002bed22e9a731`
- Audit: live desktop and 390px layouts had no document overflow; Yes/No/Unsure were exposed as independent toggle buttons/checkboxes to accessibility APIs.
- Baseline Impeccable detector returned no findings for `frontend`.
- Final scoped Impeccable layout detector returned `[]` for `match-game.tsx`.
- Desktop, 320px, and 390px Playwright screenshots were inspected. The decision rail remains aligned on desktop; mobile context is clamped with disclosure controls; all choices fit above the mobile navigation without document overflow.
- Screenshot review exposed a legacy global selector that displayed every choice's `Selected` text. The state now renders only for the checked radio, with a regression assertion.
- Coordinator screenshot review found the same legacy label selector still overrode choice typography and selected contrast. Scoped selectors now enforce 14px names, 12px definitions, carbon-on-paper selected text, clear row borders, and zero leaked label margins; focused computed-style assertions cover the regression.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:proxy` passed. Proxy tests: 14/14.
- `PLAYWRIGHT_PORT=3157`, two workers: `match-ux.spec.ts` passed 4/4; the relevant Match decision, desktop layout, retry, saved-answer, debug, 409, and 500 tests in `signal-surfaces.spec.ts` passed 7/7.

## Completed

- Read repository, frontend, Next.js, Impeccable craft-floor, and layout instructions.
- Reviewed the current Match component and existing recovery/debug tests.
- Replaced independent toggle buttons with a native radio group, arrow-key selection, visible selected/focus states, and concise accessible descriptions.
- Widened the desktop judgment rail and added mobile profile/video progressive disclosure while retaining DOM order and non-sticky controls.
- Clarified the judgment heading, preserved the optional rationale and all persistence/recovery flows, and added a completion-state link.
- Added focused browser coverage for keyboard semantics, selected-state exclusivity, 320/390px geometry, disclosures, and the empty action; migrated existing Match assertions to radio roles.
- Removed the stray `frontend/npm-install.log`.

## Next action

Commit the reviewed implementation and hand it to the coordinator for independent quality review.
