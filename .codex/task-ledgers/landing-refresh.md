# Landing page and shared site refresh

Goal: Improve homepage copy, CTAs, visuals and hierarchy; use "Your attention has better places to be" as the main tagline; make core site elements consistent across pages; deliver a pull request.

Branch: codex/landing-refresh, isolated worktree based on origin/main f4a44ef.
Ownership: design director owns frontend/design implementation and builder verification. Root owns integration, independent review, PR and preview verification.

Decisions: Preserve product truth and existing working flows. No invented testimonials or outcome claims. Existing checkout changes are outside this task.

Completed: Read repository operating/deployment guidance; inspected CI and isolated preview workflow; dispatched design work with exact user tagline.
Next: Review implementation evidence, run independent quality review, create PR, verify checks and deployed preview in browser.

Design milestone: preserve existing palette/typography; shared SiteHeader/SiteFooter; editorial recommendation preview and visual process. Exact user tagline is hero. Root copy review requested replacing ambiguous 'watches channels' with metadata-accurate wording and mentioning Telegram clearly.

Verification milestone: lint, typecheck, production build, 13 route-proxy tests and 19 browser tests passed. Independent quality review cleared the final implementation after fixing hidden mobile navigation, canonical link labels, configurable pick-count copy, and flex min-content overflow. New browser journey covers shared chrome at desktop and 320px. Generated design artifacts remain local and are excluded from PR.
Next: create PR, wait for CI/isolated preview, inspect deployed build and runtime errors.

PR: https://github.com/NathanPannell/finite-feed/pull/41 (initial head 0a55e91189f57b68db90916b77b657a9cda6a689).
CI run 34061631125: frontend/backend passed. Preview run 34061631114 passed readiness and Match Lab smoke tests. Initial preview: https://finite-feed-o6w0vlt84-nathanpannells-projects.vercel.app.
Deployed browser: homepage CTA reached signed-out Google sign-in; privacy/navigation loaded; Match Lab fetched a real pair from isolated preview and description expansion worked; no warning/error console logs observed.
Browser regression caught: mobile/tablet generic masthead-context hiding also hid Match Lab h1. Builder is making a minimal title-preservation fix and 320/800px assertion. Next: verify fix, push, confirm updated CI/preview and title in deployed browser.

Title fix verified: responsive hiding now applies only to decorative tagline context. Five Match Lab browser tests, lint, typecheck and diff-check passed; explicit level-1 heading assertion covers 320px and 800px.
