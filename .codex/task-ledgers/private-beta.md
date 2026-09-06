# Private beta launch

Goal: Implement immediate-impact scope of GitHub #27–31, verify isolated preview and production, merge only after quality checks and deployed browser verification.

Decision: Defer soak testing, large human evaluation and extensive metrics into explicit GitHub backlog issues. Preserve essential auth/ownership, migration and journey checks.

Workspace: isolated worktree finite-feed-private-beta, branch codex/private-beta from origin/main c7f1727. Existing checkout changes preserved.

Active: accounts agent owns backend account/auth/onboarding; pipeline agent owns worker, recommendations/feedback and Telegram; frontend agent owns landing and personal app. Root owns deployment wiring, rate limiting, runbook, integration, backlog and merge.

Next: resolve Neon branch-specific auth configuration, integrate account contract, validate targeted checks, independent quality review, deploy preview, browser verify, merge and verify production.

Backlog created: #32 invited soak/fault injection; #33 human-held-out evaluation and metrics; #34 restore/rollback rehearsal and proactive alerts (all assigned NathanPannell).

Milestone: migrations 0013/0014 apply and checksums verify in isolated local pgvector container finite-feed-beta-check on port 55434. Root request-limit tests 2/2 and deployment-variable tests 4/4 pass. Google shared provider confirmed enabled; existing GitHub NEON_AUTH_COOKIE_SECRET available. Workflows resolve Neon Auth endpoint per branch and pass matching endpoint to API/Vercel.

Builder verification: full backend suite 137 passed using real isolated PostgreSQL (pytest --basetemp .pytest_cache/beta-tmp avoids unrelated Windows temp-directory ACL issue). Frontend lint/type/build, 10 proxy checks and 18 E2E passed. Pipeline targeted checks cover budgets, feedback, abstention, partial counts, recipient isolation, DST/pause. Independent quality review started; deployment and real browser journeys remain required.

Review milestone: independent quality review approved reported blocker fixes after 26 related PostgreSQL checks. Root full suite150 passed. Fixed deletion/model transaction race, unlink/send race, Telegram abstention/provider retry loop, resolver quota bypass, cookie minimization and Node22/npm10 clean-install lockfile. Frontend clean npm ci/build/type/lint pass under CI-compatible runtime. PR35 draft created; first CI failures were stale timezone test expectation and four missing optional peers, now repaired. Final CI/deployed browser verification pending.

Live verification: both CI and preview workflow passed at c874b1b; exact /ready SHA matches. Public landing and protected admin load in Browser without console errors. Real Neon sessions from two disposable isolated test accounts verified provisioning, preferences, timezone/hour/count, pause, independent follows, export and deletion/old-session denial. No Google result is inferred from those email-session fixtures. Live model generation twice returned503; investigating sanitized provider cause. Browser Google flow fails upstream shared-client redirect_uri_mismatch; issue36 records exact fix and user asked to sign in to Google Cloud. No merge until resolved.

OAuth milestone: Custom Google web client configured in production and preview Neon branches with exact callback URLs. Credential transferred encrypted in memory after browser download/export proved unsupported; no cleartext secret emitted or committed, temporary transfer key removed. Google consent succeeds. Live callback currently lands at root with session verifier and fails to establish app session; accounts agent repairing SDK callback. CI and preview passed at279149c. OpenRouter free-only server fallback under review for live upstream429.
