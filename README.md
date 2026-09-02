# Finite Feed

Finite Feed reduces fire-hose YouTube channels to one unusually valuable recommendation at a time. The first dogfood release targets TED and TEDx, learns from explicit preferences and feedback, and makes every recommendation decision inspectable.

## What is implemented

- Versioned preference profiles with an auditable Markdown view.
- Editable delivery cadence, time, timezone, and recommendation volume.
- Idempotent tracked-channel storage with TED and TEDx defaults.
- Video, recommendation, interaction-event, click, and feedback records.
- A deterministic baseline ranker combining preference overlap with age- and channel-normalized momentum.
- A mobile-friendly redirect that records `clicked` before opening YouTube.
- A responsive dashboard for preferences, sources, history, feedback, and quality metrics.
- A production-safe worker that disables preview delivery and stays paused until provider keys exist.

YouTube ingestion, transcript embeddings, model reranking, Telegram webhooks, and outbound delivery are the next integration slice. Their configuration values are intentionally blank in `.env` and `.env.example`.

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

## Verify

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests
Push-Location frontend; npm run lint; npm run typecheck; npm run build
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for deployment lifecycle details and [INSTALLATION_ISSUES.md](INSTALLATION_ISSUES.md) for bootstrap problems found during initial setup.
