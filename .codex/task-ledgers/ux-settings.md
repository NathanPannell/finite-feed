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

## Coordinator verification and corrections
- Root awaited legacy tests: three failures were stale save-button labels and the new source confirmation, rather than server contention. Updated those behavior expectations and stopped remaining verified task-owned servers.
- Preserved draft isolation and disabled edits while either preference save is pending; added a delayed-response cross-form regression. Source cancel restores trigger focus; removal focuses the add-source field and explains recovery.
- Lint exposed generated Playwright report bundles; added scoped report/results ignores to ESLint. Lint now passes with artifacts retained; typecheck/build also pass.
- Final relevant browser run: 13/13 passed at port3127, including existing delivery, Telegram, source, feed, memory and all6 dedicated settings tests. Proxy14 passed in unchanged routing contracts in the companion navigation branch.
- Fresh desktop/320px fixture screenshots inspected by root; no document overflow. Current screenshots: frontend/playwright-report/data/5135542f29c66dd0194dad46aae32a2a971c9bc7.png and 8931b00f68ef24c03702d238bb719eecf1585deb.png. No production account data in these fixtures. Detector on changed sources returned empty.

## Next
- Independent quality review, then root creates the issue-linked PR; no merge.

## Independent review follow-up
- Canonicalize trimmed timezone aliases to the IANA name sent to the server and reject numeric offsets before submission. This prevents browser-accepted values from failing the Python ZoneInfo contract.
- Final focused settings run: 7/7 passed, including alias normalization, offset rejection, and delayed cross-form draft preservation. Production build and lint passed again after the fix.
