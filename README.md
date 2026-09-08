# Finite Feed

Finite Feed reduces fire-hose YouTube channels to one unusually valuable recommendation at a time. The first dogfood release targets TED and TEDx, learns from explicit preferences and feedback, and makes every recommendation decision inspectable.

## Development and releases

Feature PRs target `staging` and are reviewed and merged by a different agent. Staging deploys to the permanent test site at `https://finite-feed-staging.vercel.app`, with its own long-lived Neon database/Auth branch and Railway services. Google sign-in works on staging and production; disposable PR previews use isolated email/password verification and do not require Google callbacks.

After combined staging tests and browser verification pass, prepare a versioned release PR from `staging` to `main`. Production changes only when that release is merged, and successful deployment publishes the version tag and displays version metadata in the frontend. See [CICD_OPERATIONS.md](CICD_OPERATIONS.md) for review, release, and environment ownership rules.

## What is implemented

- Google and email/password sign-in with isolated accounts, self-service settings, Telegram linking, export and deletion.
- Resumable onboarding with structured interests, an open response, profile review, delivery setup, and optional Telegram linking.
- Public landing page at `/`, personal feed at `/app`, settings at `/app/settings`, and separate protected `/admin`.
- Versioned preference profiles with an auditable Markdown view.
- Editable delivery cadence, time, timezone, and recommendation volume.
- Idempotent tracked-channel storage with TED and TEDx defaults.
- Video, recommendation, interaction-event, click, and feedback records.
- A deterministic baseline ranker combining preference overlap with age- and channel-normalized momentum.
- A worker that resolves tracked YouTube channels, imports recent uploads, and refreshes changed metadata.
- Self-hosted Arctic Embed XS vectors with pgvector HNSW cosine retrieval and no hosted embedding service.
- Recent and evergreen shortlists followed by an OpenRouter final selection and grounded rationale.
- Scheduled Telegram delivery, a two-pick precomputed queue, thumbnails, one-tap feedback, and confirmed preference additions.
- An authenticated dashboard redirect that records `clicked`; Telegram opens YouTube directly.
- A responsive dashboard for preferences, sources, history, feedback, and quality metrics.
- A public match lab for collecting anonymous, reasoned human judgments on profile-video pairs.
- A runtime Control Room switch that shows or hides Match Lab links on the public home page without disabling direct access.
- A production-safe worker that ingests previews but disables preview delivery.

Transcript ingestion, developer-bot preview routing, and a repeatable human-scored evaluation set remain post-baseline work.

## Recommendation pipeline

The worker checks TED and TEDx on a configurable interval, stores normalized video metadata, and only rebuilds a vector when a title or description changes. It retrieves up to five strong recent candidates and ten unsent evergreen candidates, then asks the configured OpenRouter model to choose one. If the provider fails or is not configured, it uses the candidate with the highest raw cosine similarity. The exact shortlist, scores, model, fallback state, and rationale are stored with every recommendation.

The initial integration pins `google/gemma-4-31b-it:free` instead of using OpenRouter's changing free-model router. Revisit the pin deliberately when model quality, availability, or evaluation results justify it.

Undelivered recommendations are reused rather than regenerated. Delivery is serialized per recommendation and DB events are idempotent; the Telegram send itself remains at-least-once in the rare case that Telegram accepts a message but the following database commit fails.

Telegram keeps two recommendations ready for each linked account. A request consumes one without waiting on the model, and an independent worker loop refills the durable slot with leased, retryable work. A newly linked account, a preference change, or a burst beyond the two ready items can briefly return an empty-queue message while the worker prepares fresh matches.

## Telegram setup

In `/app/settings`, choose **Connect manually** to display a copyable six-digit code without opening Telegram. Search for the bot shown on that screen, start its private chat, and send the six-digit code. The code expires after ten minutes and can be used once. The separate Open Telegram option keeps the existing direct-link flow.

`/recommend` sends a prepared pick immediately and requests an asynchronous refill toward two ready picks. Changes to preferences discard stale picks and rebuild the queue. Cold starts, rapid requests, or unavailable matches can temporarily empty it; the bot replies with a preparation message instead of waiting for model generation. Ordinary text asks for confirmation before adding it to existing preferences.

## Run locally

Requirements: Docker, Python 3.13+, and Node 22+.

```powershell
docker compose up -d postgres
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
.\.venv\Scripts\python.exe -m backend.app.migrate
npm ci
Push-Location frontend; npm ci; Pop-Location
```

Run the API, worker, and frontend in separate terminals:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload --port 8000
.\.venv\Scripts\python.exe -m backend.worker.main
Push-Location frontend; npm run dev
```

Open `http://localhost:3000`. `/health` checks liveness; `/ready` checks migrations and reports the deployed commit.

Add runtime credentials as GitHub Actions repository secrets. The deployment workflows forward them into the matching Railway production and preview services; `.env.example` contains names and safe defaults only.

The private admin dashboard requires the `VERCEL_TEAM_SLUG` and
`VERCEL_PROJECT_NAME` repository variables. Keep Vercel Authentication on
**Standard Protection** (`all_except_custom_domains`): the public custom domain
continues to serve `/match`, while the Next.js route proxy redirects only
`/admin` and `/api/admin` to the SSO-protected generated deployment URL.
The proxy fails closed with 503 in production if `VERCEL_URL` is unavailable.
Vercel OIDC independently secures the Railway admin API hop.
Home-page feature visibility is loaded from the API without caching. If that read is unavailable, Match Lab links remain visible to preserve the default experience.

## Verify

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests
.\.venv\Scripts\python.exe -m backend.evals.run_description_cleanup_eval
.\.venv\Scripts\python.exe -m backend.evals.run_recommendation_eval
.\.venv\Scripts\python.exe -m backend.evals.benchmark_embeddings
Push-Location frontend; npm run lint; npm run typecheck; npm run build
```

After configuring OpenRouter, add `--with-model` to exercise the live low-cost model against the same genre-specific cases.

See [ARCHITECTURE.md](ARCHITECTURE.md) for deployment lifecycle details and [INSTALLATION_ISSUES.md](INSTALLATION_ISSUES.md) for bootstrap problems found during initial setup.
See [SEMANTIC_EMBEDDINGS.md](SEMANTIC_EMBEDDINGS.md) for semantic rollout, verification, benchmarking, and rollback.
See [MATCH_LAB_DATASET.md](MATCH_LAB_DATASET.md) for reproducible curation, guarded replacement, reviewer identity, and debug-assessment operations.
See [DESCRIPTION_PROCESSING.md](DESCRIPTION_PROCESSING.md) for deterministic description cleanup and Match Lab language eligibility.
See [BETA_OPERATIONS.md](BETA_OPERATIONS.md) for budgets, worker status, safe retry, privacy boundaries and recovery. The invited soak, human-quality study and recovery rehearsal are follow-ups #32–34, not completed release evidence.
