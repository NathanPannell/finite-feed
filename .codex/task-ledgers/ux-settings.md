# Settings UX

## Goal
Make Settings a clear, responsive task surface without changing API, authentication, delivery, Telegram, export, or deletion behavior.

## Success condition
Routine preferences lead the page, account controls follow them, and focused tests plus desktop and mobile evidence pass.

## Decisions
- Scope styles in `components/settings-layout.module.css` to prevent shared UI regressions.
- Preserve existing route-mocked contracts and accessibility labels; add localized feedback for preference forms.
- Keep Telegram controls in account management to avoid a second account request.

## Completed
- Read repository/frontend instructions, Next bundled CSS/RSC guidance, and Impeccable layout/craft references.
- Removed the untracked frontend npm-install log after installation completed.
- Reordered Settings into routine task sections followed by account/privacy and added scoped layout styles plus localized form feedback.
- Added explicit, recoverable source-removal confirmation; re-adding remains the existing supported recovery path.
- Added browser-native IANA timezone validation with local accessible recovery feedback and draft retention.
- Visual review found narrow three-column density on desktop, so Settings now uses two routine columns with full-width sources and a two-row mobile section navigator.

## Next
- Settings implementation committed as `5c58c4f`.
- Completed: `npm run lint`, `npm run typecheck`, and `npm run build`; dedicated `settings-ux.spec.ts` passed 5/5 with `CI=1`, `PLAYWRIGHT_PORT=3117`, and one worker.
- Completed visual inspection: route-mocked Settings desktop and 320px screenshots were reviewed through the Playwright HTML report; the initial desktop three-column layout was corrected to two columns.
- Incomplete: six selected legacy `signal-surfaces.spec.ts` cases exceeded the tool window and left four owned local Next processes listening on 3117–3120 (PIDs 43652, 32760, 35764, 46440). Do not report those cases as passed.
