# CI/CD hardening
Goal: agent-friendly PR-only main, serialized reliable releases, preview credential hygiene and complete cleanup, production-build browser tests, dependency maintenance.
Baseline: 78f804db9c195f8ab9209e73637b0851e9582e95; branch codex/cicd-hardening.
Owners: Sol production_hardening owns ci.yml/deployment checks; Sol preview_hardening owns preview.yml/isolation/cleanup; Sol frontend_ci owns browser config/tests; root owns integration/settings/docs/action pinning.
Constraints: no direct main push; retain Neon branch architecture; no secret outputs; preserve existing user edits in original worktree.
Next: implement, targeted tests, independent quality review, push PR and verify CI/preview, configure GitHub controls if supported.

Milestone: GitHub vulnerability alerts and automated security fixes enabled; GET verified enabled=true/paused=false. PUT main/protection rejected HTTP 403 requiring eligible private-repo plan. Ready policy .github/main-protection.json requires PR, strict backend/frontend/deployment-contracts checks, zero mandatory human reviews, admin enforcement, no force-push/delete bypass.
Upstream moved to d4982a5 via onboarding PR #40 during implementation. Workers notified; root will integrate after builds before final verification.
Repository AGENTS now explicitly forbids direct main push; CICD_OPERATIONS distinguishes existing Neon/cleanup safeguards from remaining gaps. Private improvement log records audit-framing correction.

Milestone: PR #44 https://github.com/NathanPannell/finite-feed/pull/44, branch pushed be1e41f incorporating upstream e90bf34 dependency updates. Production-mode E2E30/30; native smoke credential tests9/9; Node48 passed + Linux shell regression1 passed separately. First GitHub backend/frontend passed. Fixed GitHub-only ShellCheck style issues and added bounded strict Railway variable convergence after initial preview failed isolation.
Independent quality: no remaining blocking static defect; found/fixed close-reopen interruption race with per-PR cancel:false and live state guards. Must prove variable removal with second live preview run; inherited variable semantics remain possible root cause, not assumed resolved by tests.
Remaining: second GitHub CI/preview, real browser inspection, ready/merge PR, verify production and closure cleanup; final report main protection plan blocker. Safe scheduled reconciliation omitted/documented.
