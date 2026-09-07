# Persistent staging deployment

Goal: deploy every current `staging` branch head to permanent, isolated Neon, Railway, and Vercel staging resources.

Success condition: the `deploy-staging` check reuses permanent resources, rejects stale source, deploys API and worker at the exact SHA, promotes a separate Vercel staging project to its stable HTTPS origin, verifies CORS/Auth trust and Google OAuth, and never exposes production Telegram credentials.

## Decisions

- Neon branch: `staging`, parented from production once, database `app`, role `app_owner`, no expiry.
- Railway environment: `staging`, copied once from the configured base environment and then updated in place.
- Vercel: the existing production project, preview-target staging deployment, Standard Protection, and a stable domain bound to Git branch `staging`.
- Staging delivery stays disabled. Developer Telegram may be configured, while production bot and chat variables are removed and verified absent.
- New repository variable: `STAGING_FRONTEND_URL`; existing Vercel project identity is reused.

## Completed

- Added a serialized `deploy-staging` workflow restricted to the current `staging` branch head.
- Added permanent Neon branch reuse with no expiration and branch-local Auth resolution.
- Added atomic, retry-safe creation and reuse of an isolated Railway `staging` environment.
- Added staging variable reconciliation with delivery disabled and production Telegram credentials removed.
- Added a protected preview-target deployment in the shared Vercel project, explicit stable staging-alias promotion, version/build metadata, exact CORS allowlist, and required Google OAuth smoke.
- Added exact Neon Auth trusted-domain reconciliation so inherited production and obsolete preview origins are removed only from `staging`.
- Verified all 84 runnable JavaScript contract tests pass (one unrelated test skipped), the new workflow passes pinned actionlint 1.7.7, and YAML parsing succeeds.

## Provider state

- Permanent Neon branch `br-calm-night-arlz5g0l` exists as `staging` with no expiry and isolated Auth.
- Stable `https://finite-feed-staging.vercel.app` is assigned to the existing Vercel project with `gitBranch=staging`; the production domain remains unbound to a Git branch.
- The permanent Google callback is registered.
- Railway `staging` remains to be created through the atomic workflow helper after this change is pushed.

## Next action

Run independent review, commit the owned files, then dispatch or push the current staging head so the workflow creates Railway and verifies the live stack.
