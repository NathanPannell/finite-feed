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
