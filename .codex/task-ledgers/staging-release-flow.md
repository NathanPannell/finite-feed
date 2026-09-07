# Persistent staging and versioned releases

Goal: two long-lived branches, `staging` for agent integration and `main` for production; persistent isolated Neon Auth/database and Railway services for staging; Google sign-in on both; reviewed releases with frontend version metadata.

Success: reviewed feature PRs merge into staging, stable staging deploys and passes automated/browser/auth verification, release PR targets main with an exact tested candidate and version, production remains unchanged until that release is merged. Staging resources survive PR closure and expiry cleanup.

## Ownership and decisions
- Root: coordination, repository guidance, provider configuration, Google callback registration, final integration/browser verification.
- staging_integration: create staging from main, retarget and independently merge the 12 previously reviewed PRs using merge commits; never merge main.
- persistent_staging: staging workflow and new provider lifecycle helpers/tests; long-lived isolated resources, no production Telegram credentials.
- release_versioning: CI/release workflows, version metadata and frontend display/tests.
- Independent quality review follows implementation and builder tests.
- Implementation worktree: `C:/repo/finite-feed-workspace/.worktrees/staging-release-flow`; assembled all 12 final PR heads locally without modifying the dirty primary checkout.
- Existing production: `https://finite-feed-rho.vercel.app`; Neon project `young-term-52198665`; Railway project `c5afafde-5c64-4dae-98e0-70676a53df50`.
- Preview Google remains optional. Persistent staging Google and production Google are required.
- Existing GitHub private-plan limitation prevents server-side branch protection. Independent agent review must be real; do not fabricate self-approval through the shared GitHub identity.

## Progress
- Read repository instructions and current deployment contracts; current production only deploys from main, all 12 PRs currently target main.
- Created isolated implementation branch `codex/staging-release-flow`; implementation delegated with non-overlapping ownership.
- User explicitly confirmed long-lived Neon database and Railway environment for staging.

## Next
Integrate reviewed PRs into staging, implement/test workflows and metadata, provision permanent staging resources, verify Google/browser journeys, independently review, merge setup through a staging PR, then open the reviewed release PR without merging production.
- Integration agent created staging from released main25cbfa9, retargeted/merge-committed all12 reviewed PRs, and verified their exact heads are ancestors of staging15fb44b8b845d28f8d9586a08705c23870c2eb3e. Main unchanged; all disposable preview cleanup runs passed/skipped as intended. Root merged actual staging ancestry into implementation branch without changing worker edits.
- GitHub default branch changed to staging; main and staging exist; delete_branch_on_merge remains false. Both unprotected due known private-plan limitation.
- Permanent Neon staging created as br-calm-night-arlz5g0l, parent br-silent-firefly-arupbgv4, no expiry. Defaults were required because custom suspend timeout is unavailable on account. Auth inherited automatically; explicit provisioning409 was harmless and no schema was dropped. Base URL https://ep-rapid-frog-arlctmnt.neonauth.c-4.us-west-2.aws.neon.tech/app/auth.
- Registered exact persistent staging Google callback in existing Finite Feed - Neon Auth client and reloaded to verify12 entries, preserving11 existing entries. No approval blocker. Stable staging frontend added to branch trusted domains; workflow will reconcile inherited origins to isolated staging origins.
- Created separate Vercel finite-feed-staging project prj_q9B1i5lVOl3SCoVMAFT8rPhkI5cL, Next.js/Node22, StandardProtection all_except_custom_domains, no Git auto-deploy link. API confirms verified stable domain finite-feed-staging.vercel.app. Set three repo variables VERCEL_STAGING_PROJECT_ID, VERCEL_STAGING_PROJECT_NAME, STAGING_FRONTEND_URL.
- Root updated AGENTS/CICD operations with builder-versus-reviewer roles, staging→main release policy, permanent environment boundaries and optional disposable-preview Google; Dependabot explicitly targets staging. Declared staging branch-protection policy added; server-side enforcement unavailable on current plan.
- User asked where staging previews are; clarified permanent site exists as configured URL but first deployment is still being built; old disposable PR previews were cleaned after integration merges.
- User explicitly requested deleting Google redirect URIs except production and staging. Queried Neon Auth for both exact endpoints, removed10 obsolete entries, saved and reloaded Google client; exactly2 callbacks remain (production ep-young-block-ari2ef6m and staging ep-rapid-frog-arlctmnt).
- User changed Vercel requirement to shared production project. Moved verified finite-feed-staging.vercel.app domain from newlycreated unused project into existing finite-feed/prj_fjJOcr0wMvQJAqf249RP09yxzyi0, bound gitBranch=staging. Production finite-feed-rho.vercel.app remains gitBranch=null. Verified unused project had no deployments/domains, removed it and obsolete VERCEL_STAGING_* variables; STAGING_FRONTEND_URL retained. This supersedes earlier separate-project design.
- Persistent staging worker adapting to Vercel preview target + stable staging alias in sameproject. It identified admin-preview bypass on stable customdomain; release/frontend worker owns staging-specific protected-deployment routing and meaningful authorization regressions. Independent review must include this risk.
- After Google callback pruning, fresh production sign-out→Google sign-in again returned to /app with one existing recommendation and no browser warnings/errors. No account settings, feedback, or delivery actions changed.
- Persistent staging builder checkpoint fd4986f passed85runnableJS contracts plus1unrelatedskip, YAML parse and pinned actionlint. Dedicated quality-profile spawn/resume was unavailable due agent-thread limit; reused independent staging_integration agent, which did not build implementation, for substantive review.
- Independent review ran19focusedtests and found two fix-before-merge gaps: initial Railway copy must atomically replace worker direct DB and API Auth/CORS inherited production values; live workflow must verify stable staging /admin and /api/admin/summary protection after alias promotion. Owner is fixing both before push/deployment, with release worker owning the matching frontend stage-admin gate.
- Release preparation design avoids GITHUB_TOKEN-created PR approval/trigger ambiguity: workflow attests exact staging SHA/version/checks; authenticated local helper creates/updates staging→main PR only after completed successful attestation. Production will revalidate frozen candidate and publish tag only after successful deployment. Exact operator commands and final tests pending builder handoff.
- Review corrections completed: atomic Railway staging credentials/Auth/CORS, stable administrator-route checks, exact current staging CI gate, release check freshness/timeouts, repeated production candidate guards, and uncached version endpoint. Builder evidence: 94 runnable repository JS tests plus one existing skip; frontend lint/typecheck/22 tests/build and metadata browser check; pinned actionlint passes. Final independent rereview pending.
- Staging now uses shared Vercel project only; root documented exact release attestation and authenticated PR-preparation commands, patch releases through staging, and unchanged explicit production release approval boundary.
