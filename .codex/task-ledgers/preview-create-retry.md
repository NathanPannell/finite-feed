# Railway preview creation retry

Goal: Make simultaneous full-stack PR previews tolerate Railway's workspace limit of one environment creation per 30 seconds without weakening preview isolation.

Success conditions:
- Reuse an existing exact `pr-N` environment.
- Retry only the documented environment-creation throttle, with bounded attempts and deterministic jitter beyond 30 seconds.
- Recheck the exact environment after a failed create to accept an ambiguous success.
- Preserve every atomic database, delivery, and production Telegram override on each create attempt.
- Fail immediately and safely for other provider errors.

Evidence:
- PRs 57, 58, 60, and 61 reached `railway environment new` concurrently and failed the shared workspace's one-environment-per-30-seconds limit.
- PR-scoped workflow concurrency prevents overlap within one PR but does not serialize provider mutations across distinct PRs.
- The helper validates an exact `pr-N` target, checks for it before each attempt and after every failed create, retries only the provider's 30-second creation throttle, and emits sanitized terminal errors.
- Retry delay is 32–39 seconds with deterministic PR-based jitter, bounded to eight attempts; unrelated provider failures stop after the first attempt.
- The full atomic service configuration remains covered by an exact argument test, including isolated pooled/unpooled database values, disabled delivery, and disabled production Telegram credentials for both services.
- `node --test scripts/create-railway-preview-environment.test.mjs scripts/preview-workflow.test.mjs` passed 10/10.
- `node --test scripts/*.test.mjs` passed 56 tests with 1 expected Windows-only skip and 0 failures.
- `git diff --check` passed.
- Ported the verified deterministic Vercel project-link helper from `12b2b92`: immediately before native-session smoke, the preview workflow atomically writes the configured `team_…` and `prj_…` IDs to runner-local `frontend/.vercel/project.json` without invoking interactive linking or printing identifiers.
- The native-auth `--auth-only` smoke and all preceding callback/provider gates remain unchanged.
- Python 3.13 focused tests passed 13/13 using a worktree-local pytest base directory because the host's shared pytest temp root is permission-locked.
- Deployment contracts still pass 56 tests with 1 expected Windows-only skip and 0 failures after the port.

Next action: Commit for independent review and cherry-pick onto the affected PR branches.
