# Finite Feed agent handoff

Read `README.md`, `ARCHITECTURE.md`, and `INSTALLATION_ISSUES.md` before changing the app or deployment. Frontend work must also follow `frontend/AGENTS.md`.

## Current steady state (2026-09-03)

- Production: `https://finite-feed-rho.vercel.app` and `https://api-production-4f7bb.up.railway.app`.
- PR #5 (`4f2304fbc3ca2cb61cf395ca2528c3a4e8a73ece`) is deployed. `/ready` matched that SHA; 251/251 videos were embedded.
- Two recommendations existed at handoff: one delivered and one older model-backed pending row. A worker restart did not create or deliver another row.
- PR CI, PostgreSQL migration/integration tests, the Railway/Vercel/Neon preview lifecycle, cleanup, and an independent review passed.

## Operational guardrails

- Runtime credentials live in GitHub Actions secrets and are forwarded by the workflows. Never print, commit, or copy their values into documentation.
- `OPENROUTER_MODEL` is a non-secret repository variable pinned to a general-purpose free model. The current key is limited to free models and roughly 50 requests/day; prefer offline evals and make live calls deliberately.
- Scheduled failures have a persisted one-hour retry gate. Only model-backed pending recommendations may be delivered, delivery is serialized, and delivery events are DB-idempotent.
- Telegram remains at-least-once across the irreducible case where Telegram accepts a send but the following database commit fails.
- Preview workers ingest data but must never send production Telegram messages or retain production-only credentials.
- Trust a deployment only when `/ready` reports the intended Git SHA. Do not treat a Railway restart as proof that new source deployed.

## Local and follow-up work

- Docker Desktop failed locally while initializing its `dockerInference` socket. Do not delete Docker state automatically; CI PostgreSQL is the verified fallback until the host issue is fixed.
- GitHub frontend `npm ci` took several minutes during the last runs but completed successfully; do not cancel it prematurely without evidence of failure.
- Keep the present baseline stable. Build the requested admin dashboard later as its own focused PR, then add features in small PRs with production and preview verification.
- Reusable bootstrap findings are tracked in `NathanPannell/full-stack-app-template` issues #2, #3, and #4.
