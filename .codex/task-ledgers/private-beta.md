# Private beta launch

Goal: Implement immediate-impact scope of GitHub #27–31, verify isolated preview and production, merge only after quality checks and deployed browser verification.

Decision: Defer soak testing, large human evaluation and extensive metrics into explicit GitHub backlog issues. Preserve essential auth/ownership, migration and journey checks.

Workspace: isolated worktree finite-feed-private-beta, branch codex/private-beta from origin/main c7f1727. Existing checkout changes preserved.

Active: accounts agent owns backend account/auth/onboarding; pipeline agent owns worker, recommendations/feedback and Telegram; frontend agent owns landing and personal app. Root owns deployment wiring, rate limiting, runbook, integration, backlog and merge.

Next: resolve Neon branch-specific auth configuration, integrate account contract, validate targeted checks, independent quality review, deploy preview, browser verify, merge and verify production.

Backlog created: #32 invited soak/fault injection; #33 human-held-out evaluation and metrics; #34 restore/rollback rehearsal and proactive alerts (all assigned NathanPannell).

Milestone: migrations 0013/0014 apply and checksums verify in isolated local pgvector container finite-feed-beta-check on port 55434. Root request-limit tests 2/2 and deployment-variable tests 4/4 pass. Google shared provider confirmed enabled; existing GitHub NEON_AUTH_COOKIE_SECRET available. Workflows resolve Neon Auth endpoint per branch and pass matching endpoint to API/Vercel.

Builder verification: full backend suite 137 passed using real isolated PostgreSQL (pytest --basetemp .pytest_cache/beta-tmp avoids unrelated Windows temp-directory ACL issue). Frontend lint/type/build, 10 proxy checks and 18 E2E passed. Pipeline targeted checks cover budgets, feedback, abstention, partial counts, recipient isolation, DST/pause. Independent quality review started; deployment and real browser journeys remain required.
