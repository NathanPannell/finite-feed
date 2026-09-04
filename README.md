# Finite Feed

Finite Feed reduces fire-hose YouTube channels to one unusually valuable recommendation at a time. The first dogfood release targets TED and TEDx, learns from explicit preferences and feedback, and makes every recommendation decision inspectable.

## What is implemented

- Versioned preference profiles with an auditable Markdown view.
- Editable delivery cadence, time, timezone, and recommendation volume.
- Idempotent tracked-channel storage with TED and TEDx defaults.
- Video, recommendation, interaction-event, click, and feedback records.
- A deterministic baseline ranker combining preference overlap with age- and channel-normalized momentum.
- A worker that resolves tracked YouTube channels, imports recent uploads, and refreshes changed metadata.
- Reusable local feature-hash vectors for title-and-description retrieval without per-run embedding costs.
- Recent and evergreen shortlists followed by an OpenRouter final selection and grounded rationale.
- Scheduled Telegram delivery, one-tap feedback, tracked redirects, and conversational profile updates.
- A mobile-friendly redirect that records `clicked` before opening YouTube.
- A responsive dashboard for preferences, sources, history, feedback, and quality metrics.
- A production-safe worker that ingests previews but disables preview delivery.

Transcript ingestion, richer semantic embeddings, developer-bot preview routing, and a repeatable human-scored evaluation set remain post-baseline work.

## Recommendation pipeline

The worker checks TED and TEDx on a configurable interval, stores normalized video metadata, and only rebuilds a vector when a title or description changes. It retrieves up to five strong recent candidates and ten unsent evergreen candidates, then asks the configured OpenRouter model to choose one. The exact shortlist, scores, model, fallback state, and rationale are stored with every recommendation.

The initial integration pins `google/gemma-4-31b-it:free` instead of using OpenRouter's changing free-model router. Revisit the pin deliberately when model quality, availability, or evaluation results justify it.

Scheduled model failures use a persisted one-hour retry backoff, and undelivered model-backed recommendations are reused rather than regenerated. Delivery is serialized per recommendation and DB events are idempotent; the Telegram send itself remains at-least-once in the rare case that Telegram accepts a message but the following database commit fails.

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

## Verify

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests
.\.venv\Scripts\python.exe -m backend.evals.run_recommendation_eval
Push-Location frontend; npm run lint; npm run typecheck; npm run build
```

After configuring OpenRouter, add `--with-model` to exercise the live low-cost model against the same genre-specific cases.

See [ARCHITECTURE.md](ARCHITECTURE.md) for deployment lifecycle details and [INSTALLATION_ISSUES.md](INSTALLATION_ISSUES.md) for bootstrap problems found during initial setup.
