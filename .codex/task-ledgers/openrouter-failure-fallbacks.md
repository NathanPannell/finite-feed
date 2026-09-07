# OpenRouter failure fallbacks

Goal: audit production OpenRouter paths; keep profile creation and video selection usable through provider failure; deliver a reviewed PR.
Success: profile fallback preserves supplied answers; selection fallback chooses highest cosine similarity with honest evidence; automated checks and isolated preview verification pass.

- Base: origin/main 25cbfa9c90daec2d8d5a3485ca002bed22e9a731.
- Branch: codex/openrouter-failure-fallbacks; isolated worktree preserves unrelated existing work.
- Worker fallbacks owns backend changes/tests and relevant documentation.
- Worker production_audit owns bounded synthetic production/provider checks; no real-user changes, Telegram sends, production configuration changes, merge or deployment.
- Parent owns integration, independent quality review, PR, CI and preview browser verification.
- Assumption: request asks for a PR; changes remain unmerged until requested. Current production can be tested; new failure behavior is verified offline and on the PR preview.
- Next: collect implementation and production evidence; independently review, push PR, inspect checks and deployed preview.

- Local integration DB: isolated Docker compose project finite-feed-openrouter-fallbacks on port 55439; all migrations through 0017 applied. Existing project databases untouched.

Production evidence (2026-09-07):
- `/ready` healthy, API and worker commit 25cbfa9c90daec2d8d5a3485ca002bed22e9a731, 20 migrations, fresh worker heartbeat.
- Synthetic onboarding synthesis POST returned HTTP 502 in 1.17s with sanitized provider-unavailable message. Exact upstream reason unavailable: local Railway CLI unauthenticated.
- A separate synthetic account with a manual profile generated a recommendation: HTTP 201 in 6.0s, model-backed evidence, resolved model present, shortlist of 15.
- Both test-owned app accounts deleted (204), sessions signed out (200); no Telegram linking or sends.
- No production configuration changes or fault injection. New fallback semantics require automated failure injection and PR-preview verification.

Implementation checkpoint:
- Profile fallback concatenates all structured labels and exact stored open response; normal acceptance/persistence works, with fallback audit metadata and no invented model.
- Video fallback selects highest raw cosine, retains that candidate through shortlist truncation, and is reusable by API/queue/scheduled delivery; valid explicit model abstention remains unchanged.
- Builder: 214 backend tests passed against isolated PostgreSQL; 65 focused final tests passed. Preview smoke: 11 passed. Independent quality review running.
- Documentation updated to reflect fallback delivery; no schema migration or frontend changes.

PR #62: https://github.com/NathanPannell/finite-feed/pull/62
- Initial CI: all 214 backend tests, frontend lint/typecheck/build/browser tests, and deployment contracts passed. Smoke cleanup test exposed reliance on ignored local Vercel metadata; fixed by using a temporary linked-project fixture. All 11 smoke tests pass with isolated fixture.
- Initial preview run 34160454483 hit Railway's temporary rate limit before app deployment; next push retries isolated provisioning.
- Offline recommendation eval passed 5/5 without model calls. Independent quality review remains in progress.
