# Persistent staging deployment

Goal: deploy every current `staging` branch head to permanent, isolated Neon, Railway, and Vercel staging resources.

Success condition: the `deploy-staging` check reuses permanent resources, rejects stale source, deploys API and worker at the exact SHA, promotes a protected staging preview in the shared Vercel project to its stable HTTPS origin, verifies CORS/Auth trust and Google OAuth, and never exposes production Telegram credentials.

## Decisions

- Neon branch: `staging`, parented from production once, database `app`, role `app_owner`, no expiry.
- Railway environment: `staging`, copied once from the configured base environment and then updated in place.
- Vercel: the existing production project, preview-target staging deployment, Standard Protection, and a stable domain bound to Git branch `staging`.
- Staging delivery stays disabled. Developer Telegram may be configured, while production bot and chat variables are removed and verified absent.
- New repository variable: `STAGING_FRONTEND_URL`; existing Vercel project identity is reused.

## Completed

- Added a serialized `deploy-staging` workflow restricted to the current `staging` branch head.
- Added a bounded gate that requires the latest exact-SHA staging push CI run and all four required jobs to succeed before provider mutations, then rechecks the live branch head.
- Added permanent Neon branch reuse with no expiration and branch-local Auth resolution.
- Added atomic, retry-safe creation and reuse of an isolated Railway `staging` environment.
- The initial Railway clone transaction now overrides the worker direct database URL and API Auth/CORS/OIDC values before copied services can start; later reconciliation removes worker-only extras.
- Added staging variable reconciliation with delivery disabled and production Telegram credentials removed.
- Added a protected preview-target deployment in the shared Vercel project, explicit stable staging-alias promotion, version/build metadata, exact CORS allowlist, and required Google OAuth smoke.
- Added anonymous checks that stable and generated admin routes remain behind Vercel protection, then authenticated automation checks for the app-level stable-to-generated admin redirects, `/match`, exact version metadata, and Google OAuth start.
- Added exact Neon Auth trusted-domain reconciliation so inherited production and obsolete preview origins are removed only from `staging`.
- Verified all 95 runnable JavaScript contract tests pass (one unrelated test skipped), the workflow passes pinned actionlint 1.7.7, and YAML parsing succeeds.

## Provider state

- Permanent Neon branch `br-calm-night-arlz5g0l` exists as `staging` with no expiry and isolated Auth.
- Stable `https://finite-feed-staging.vercel.app` is assigned to the existing Vercel project with `gitBranch=staging`; the production domain remains unbound to a Git branch.
- The permanent Google callback is registered.
- Railway `staging` now exists and its first API/worker deployment reached the exact staging SHA before frontend verification exposed the protected-alias assumption.
- The repaired authenticated smoke passed read-only against live staging `128d8af5b0eb76ef0ae3e74eb32dbb75dc390a02`: anonymous Vercel protection, exact app admin redirects, `/match`, version `0.1.0` staging metadata, and Google OAuth start.

## Next action

Review and merge the staging protection repair, then rerun the exact deployment and complete final browser verification.
