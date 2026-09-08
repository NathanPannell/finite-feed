# Match Lab home visibility flag

Goal: Open a PR adding a persistent admin-editable flag to hide Match Lab on the home screen without redeployment.
Success: Runtime homepage visibility follows saved flag; default preserves visibility; direct links remain usable; authorized admin writes and meaningful tests pass; independent review and PR preview browser verification complete where accessible.

Branch: codex/match-lab-feature-flag, based on origin/main 25cbfa9.
Worktree: C:/repo/finite-feed-workspace/finite-feed-match-flag.
User clarification: visibility control, not full Match Lab shutdown.
Implementation: Sol worker owns app code/tests/docs; root owns coordination, ledger, PR and CI; independent quality review follows builder verification.
Existing open PR #52 also changes homepage; keep this change focused and flag potential integration overlap.
Next: review implementation and verification evidence, create PR, inspect CI and preview.

Implementation milestone: persistent default-enabled flag, authenticated audited admin toggle, no-store public read and dynamic homepage SSR; all homepage Match Lab links conditional, direct route retained. API-unavailable fallback preserves visibility.
Verification: backend 159 passed / 45 DB-dependent skips, frontend lint/typecheck/build passed, 17 proxy/unit tests passed, 2 focused browser tests passed, diff check passed. Builder finishing isolated PostgreSQL verification; independent quality review active.
