# Deployment architecture

## Branch lifecycle

Feature PRs target the long-lived `staging` branch. A separate agent reviews the final head and merges passing changes. Once combined staging verification settles, a release PR promotes the tested staging candidate into long-lived `main`; only main deploys released production. Version tags identify the deployed production commit, and the frontend displays the version and environment. Keep staging fixed during release review or revalidate the changed candidate.

## Permanent staging

```text
staging branch → finite-feed-staging.vercel.app → Railway staging API → Neon staging
                                                Railway staging worker → same database
```

Staging has its own Vercel project, permanent Railway environment, and permanent Neon database/Auth branch. Its Neon branch is created once from production and subsequently retains its own data and migrations; deployments do not recopy production data. Code promotion does not promote staging database contents. PR cleanup and expiry must never remove these resources. Staging uses its own Auth endpoint and Google callback, exact frontend origins, and disabled production Telegram delivery. Google sign-in and native sessions must work here before a release is prepared.

## Production

```text
Vercel frontend ──HTTPS──> Railway API ──pooled SQL──> Neon production
                         Railway worker ──pooled SQL──> Neon production
                         API migrations ──direct SQL──> Neon production
```

GitHub Actions serializes production deployment after CI and rejects non-main or superseded source before provider changes. Release verification binds the main merge to the tested staging candidate and its version. It uploads the checked-out source with a baked commit stamp, waits for successful Railway deployments, and verifies the API and a fresh healthy worker heartbeat at that commit. It deploys Vercel once with the API URL and version metadata, verifies the production alias resolves to that deployment, updates exact CORS/Auth origins, then verifies final API/worker readiness and the production OAuth start. Only successful production verification publishes the matching version tag/release. Sanitized deployment IDs and readiness evidence are retained as workflow artifacts.

The API and worker images contain the same pinned Arctic Embed XS artifact and run with model-network access disabled. The worker performs the idempotent semantic backfill before ingestion and delivery. Neon stores `vector(384)` values and serves cosine nearest-neighbor queries through an HNSW index; the additive legacy vectors remain available for rollback until a later verified cleanup.

## Pull request N

```text
Vercel preview ──HTTPS──> Railway API (pr-N) ──pooled SQL──> Neon preview/pr-N
                          Railway worker (pr-N) ──pooled SQL──> same branch
                          API migrations ──direct SQL────────> same branch
```

The workflow creates or reuses deterministic `pr-N` resources and explicitly checks out the PR head; ordinary CI still tests the merge result. It gives the pooled preview URL to both services and retains the direct migration URL only on the API, removes inherited production database/bot variables, and verifies their absence before deployment. Vercel Git auto-deployment is disabled, so each run creates one frontend preview after the exact API and worker source is ready. It then writes that preview URL into Railway's CORS allowlist and the preview Neon Auth trusted domains before a final API redeploy. Do not treat unavailable preview Google sign-in or missing preview callbacks as deployment or merge failures, or request callback registration; use isolated email/password session checks. Production Google OAuth remains required and verified by the production deployment.

On close or merge, GitHub Actions attempts deletion of the Railway environment, Neon branch, and every Vercel deployment tagged for that repository and PR; provider failures fail cleanup after all providers are attempted. Verified legacy bot-recorded deployment IDs are also supported. Neon branches expire after seven days as a leak backstop. Fork PRs do not deploy. Same-repository previews deploy only when both the PR author and workflow actor match `TRUSTED_PREVIEW_ACTOR`, the GitHub user that ran the bootstrap. See `CICD_OPERATIONS.md` for branch protection, legacy-resource limits and recovery.

## Credentials and ownership

Google OAuth and email/password authentication both terminate at Neon Auth. Passwords
are never sent to the Railway API or stored in application tables; Neon Auth issues
the session that the API verifies against the configured branch endpoint. The email
address remains the user-facing identifier while `auth_subject` provides immutable
application ownership. Preview branches use their own Auth endpoint and account set.

The local bootstrap identity uses broad credentials only long enough to create one project per provider. It then stores repository automation tokens in GitHub secrets, provider IDs in GitHub variables, and runtime database URLs directly in Railway. Broad bootstrap credentials and database URLs are never committed.

`DATABASE_URL` and `PREVIEW_DATABASE_URL` are pooled runtime connections. `DATABASE_URL_UNPOOLED` and `PREVIEW_DATABASE_URL_UNPOOLED` are direct migration connections. A preview refuses to fall back to production credentials.

Tracked YouTube channels have one global canonical row and one internal owner. The
Control Room does not expose owner selection: an existing channel always retains
its owner, while a new channel is assigned server-side to the earliest-created
app user (`created_at`, then `id`) so multi-user databases behave deterministically.

## Onboarding persistence

Authenticated `/api/onboarding` endpoints persist each answer before advancing.
The session row makes the flow resumable, while append-only audit rows record the
three choices, open response, synthesis, accepted profile, delivery settings, and
Telegram decision. Model synthesis reserves the existing durable OpenRouter budget
and rechecks the saved answer revision before writing its draft. The accepted blurb
becomes a normal `preference_versions` entry. Delivery keeps the established
Sunday-first weekday values (`0` through `6`).

## Recovery rules

Re-running a failed workflow is safe because PR names are deterministic and migrations are append-only, checksummed, and advisory-locked. A Railway restart reuses the current image; it is not proof that new code deployed. Trust `/ready` only when its `commit` equals the requested Git SHA.

A browser CORS warning paired with HTTP 500 usually means the API failed before middleware produced a normal response. Inspect Railway API and migration logs first, then verify the preview database variables, direct migration URL, and exact `FRONTEND_ORIGINS` value.
