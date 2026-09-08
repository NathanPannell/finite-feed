# Finite Feed agent handoff

Read `README.md`, `ARCHITECTURE.md`, `CICD_OPERATIONS.md`, and `INSTALLATION_ISSUES.md` before changing the app or deployment. Frontend work must also follow `frontend/AGENTS.md`.

## Branches and releases

- `staging` and `main` are long-lived. Branch feature work from current `staging` and target feature PRs there; `main` is released production.
- A different agent must review the final PR head, record its identity and verification evidence, and merge only after required checks pass. Builders must not approve their own work; a shared GitHub account is not evidence of a second reviewer.
- Once the combined staging deployment passes tests and browser verification, prepare a versioned release PR from `staging` to `main`. Keep the tested candidate fixed during release review; additional commits require renewed verification. Opening a release PR does not authorize merging it.
- Merge through PRs with merge commits; never force-copy branches or push directly to either long-lived branch. Fix released problems through staging and a patch release.
- Staging has a permanent isolated Neon database/Auth branch and Railway API/worker environment. Never expire or delete these through PR cleanup.
- Google sign-in must work on staging and production. Missing Google callbacks on disposable PR previews are not failures; use isolated email/password session checks there.
- Production: `https://finite-feed-rho.vercel.app` and `https://api-production-4f7bb.up.railway.app`. Trust deployed commit/version evidence rather than historical handoff snapshots.

## Operational guardrails

- Do not bypass required checks or branch protection. See `CICD_OPERATIONS.md` for the current GitHub plan's enforcement limits.

- Runtime credentials live in GitHub Actions secrets and are forwarded by the workflows. Never print, commit, or copy their values into documentation.
- `OPENROUTER_MODEL` is a non-secret repository variable pinned to a general-purpose free model. The current key is limited to free models and roughly 50 requests/day; prefer offline evals and make live calls deliberately.
- Provider failures fall back to the nearest cosine match so delivery can continue; delivery is serialized and delivery events are DB-idempotent.
- Telegram remains at-least-once across the irreducible case where Telegram accepts a send but the following database commit fails.
- Staging and preview workers may ingest data but must never send production Telegram messages or retain production-only credentials.
- Trust a deployment only when `/ready` reports the intended Git SHA. Do not treat a Railway restart as proof that new source deployed.

## Local and follow-up work

- Docker Desktop failed locally while initializing its `dockerInference` socket. Do not delete Docker state automatically; CI PostgreSQL is the verified fallback until the host issue is fixed.
- GitHub frontend `npm ci` took several minutes during the last runs but completed successfully; do not cancel it prematurely without evidence of failure.
- Keep feature PRs small and verify combined behavior on staging before preparing a release.
- Reusable bootstrap findings are tracked in `NathanPannell/full-stack-app-template` issues #2, #3, and #4.
