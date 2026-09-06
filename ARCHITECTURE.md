# Deployment architecture

## Production

```text
Vercel frontend ──HTTPS──> Railway API ──pooled SQL──> Neon production
                         Railway worker ──pooled SQL──> Neon production
                         API migrations ──direct SQL──> Neon production
```

GitHub Actions owns production deployment after CI. It stamps both Railway services with the commit SHA, deploys them, waits until `/ready` reports that exact SHA and a readable migration table, then deploys Vercel once with the resulting API URL. It writes the actual Vercel production URLs into Railway's exact CORS allowlist and the production Neon Auth trusted domains, then redeploys the API.

The API and worker images contain the same pinned Arctic Embed XS artifact and run with model-network access disabled. The worker performs the idempotent semantic backfill before ingestion and delivery. Neon stores `vector(384)` values and serves cosine nearest-neighbor queries through an HNSW index; the additive legacy vectors remain available for rollback until a later verified cleanup.

## Pull request N

```text
Vercel preview ──HTTPS──> Railway API (pr-N) ──pooled SQL──> Neon preview/pr-N
                          Railway worker (pr-N) ──pooled SQL──> same branch
                          API migrations ──direct SQL────────> same branch
```

The workflow creates or reuses deterministic `pr-N` resources. It gives the pooled URL to both services and the direct migration URL only to the API. Vercel Git auto-deployment is disabled, so the workflow creates exactly one frontend preview after the matching API is ready. It then writes that exact preview URL into Railway's CORS allowlist and the preview Neon Auth trusted domains before a final API redeploy.

On close or merge, GitHub Actions deletes the Railway environment, Neon branch, and recorded Vercel deployment. Neon branches also expire after seven days as a leak backstop. Fork PRs do not deploy. Same-repository previews deploy only when both the PR author and workflow actor match `TRUSTED_PREVIEW_ACTOR`, the GitHub user that ran the bootstrap.

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
