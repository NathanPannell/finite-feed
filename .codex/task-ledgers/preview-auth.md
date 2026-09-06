# Preview authentication repair

Goal: Explain and repair repeated preview Google OAuth failures, and provide a safe developer-preview fallback if practical.
Context: Continuing PR40/codex/onboarding. Previous CI and preview deployment pass at992ae1e, but Google rejects preview Neon callback with redirect_uri_mismatch. Production and an earlier preview had separately registered callbacks.

## Active work
- Root traces live Neon branch config, GitHub deployment workflow and browser OAuth evidence.
- Frontend worker researches official Neon/SDK support for stable callbacks and native fallback sign-in, read-only initially.
- Preserve production authentication, live session verification, exact trusted origins and database isolation. No anonymous or shared-identity bypass.

## Next
- Confirm actual Google redirect target vs Vercel return URL and branch inheritance.
- Choose supported smallest durable repair and fallback, implement/test, independent security review, deploy and verify.

## Diagnosis
- Google client allowlist observed in console: production callback, former preview callback, current PR39 callback. PR40/41 callbacks absent.
- Neon PR40 config confirms inherited custom Google client; its own base URL differs from production. Exact Vercel preview origin is already trusted.
- Native Neon email/password is enabled with signup and no email verification on the inspected branch, so no provider-policy weakening is needed for the fallback.
- Root prepared two unsaved Google entries for PR40/41; asynchronous user approval pending because browser security policy requires confirmation for expanding OAuth redirect allowlist.
- Chosen durable fallback: native password sign-up/sign-in with server-authoritative preview environment + explicit DEVELOPER_PREVIEW_AUTH flag. No hardcoded identity or credential; keep Google and backend live session verification.
- Frontend owns UI/auth handler/tests; backend worker owns workflow/scripts/documentation. Prior shared Neon Google provider failed in earlier task, so do not replace working production custom client with it based on an untested inference.

## Implementation and local evidence
- Added native preview-only signup/signin, production route gating and UI regression tests. Dedicated browser suite now runs separately in CI.
- Workflow validates branch isolation and trusted origin and publishes the exact Google callback. Added opt-in synthetic-account smoke helper with sanitized output and preview metadata gate.
- Builder checks: lint/typecheck/build, 16 proxy tests, normal login regression, dedicated preview browser test, 11 deployment script tests, 4 smoke helper tests pass.
- Independent quality review underway. Google allowlist save remains pending explicit browser approval.
- Quality independently verified production fail-closed behavior and normal login regression; CI browser coverage gap resolved. Live helper now requires explicit preview metadata and verifies the complete onboarding and audit export with one synthesis request (5 unit tests pass).

## Delivery milestone
- Pushed 0e627e6 to PR40. CI run 34062742219 and preview run 34062742202 started.
- Independent quality review: no material findings; explicit preview metadata gate and separate CI suite confirmed. Production gate E2E and helper tests independently passed.
- Next: exact-head CI/preview readiness, browser inspection, live synthetic onboarding helper. Google callback save is still pending user confirmation.

## Final verification
- CI 34062742219 and preview 34062742202 both passed at 0e627e6.
- Fresh preview: https://finite-feed-5pqjr04rw-nathanpannells-projects.vercel.app . API ready confirms exact SHA and 17 migrations.
- Live native smoke passed signup, session revocation, same-identity signin, one LLM synthesis, full onboarding, ordered audit export, paused Telegram skip and app cleanup.
- Real browser: /app neutral loading to /login, visible logo, preview form expansion and native empty-field validation, no console errors. Browser tool has no network capture; authenticated transport checked by smoke helper.
- PR body updated with exact evidence; remains draft while Google allowlist save is pending confirmation. No production provider changes. Local ledger updates retained without a docs-only redeploy.

## User steering: permanent password authentication
- Promote existing native email/password signup/signin to official authentication with equal prominence to Google in all environments; retain email as the supported account identifier.
- Frontend worker owns permanent UI and removal of preview gates/tests; backend worker owns workflow cleanup, docs and live smoke compatibility.
- Preserve exact Neon branch isolation and pending Google callback confirmation. Next: builder checks, independent auth review, push same PR, deployed browser and real provider verification.
- Permanent email/password implementation complete: paired login methods, explicit signup/signin, display name, password autocomplete, normal browser suite and no preview gate.
- Provider read confirms main email/password signup already enabled; no provider settings changed.
- Builder checks pass: frontend lint/typecheck/build, 14 proxy tests, 4 targeted auth/routing browser tests, 25-test default discovery, 11 workflow tests and 6 helper tests.
- Independent review requested. Smoke supports auth-only verification to avoid repeating unchanged LLM onboarding work.
