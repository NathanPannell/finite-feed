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
