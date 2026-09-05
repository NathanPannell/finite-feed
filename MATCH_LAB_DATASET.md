# Match Lab dataset operations

Match Lab serves only rows explicitly loaded as curated pairs. The sample seed is loaded additively by migration `0012`; existing judgments and snapshots are preserved. See [the seed manifest](database/datasets/match-lab-v2/README.md) for counts, provenance, and verification. The replacement workflow below is a separate, destructive operator action.

## 1. Snapshot the full cross-product

Run against the intended database environment after migrations:

```powershell
python -m backend.tools.match_lab snapshot --output artifacts/match-lab-snapshot.json --source-commit <git-sha>
```

The snapshot is stably ordered and contains every active annotation profile paired with every annotation video. Its content SHA-256, deterministic snapshot UUID, source commit, migrations, counts, and source fields make subsequent curation reproducible.

## 2. Review and curate

Have the scoring model assess snapshot pairs and produce a JSON array (or an object with an `assessments` array). Every assessment must include:

```json
{
  "stable_id": "<profile-uuid>:<video-uuid>",
  "predicted_fit": "yes",
  "close_call": false,
  "selection_rationale": "Why this pair improves the human evaluation set.",
  "decision_summary": "Direct topic and format evidence strongly supports this pairing.",
  "relevance_score": 0.9,
  "difficulty_score": 0.2,
  "topic_area": "AI engineering",
  "scoring_model": "model-name",
  "scoring_model_version": "prompt-and-model-version"
}
```

Then deterministically balance 200 pairs across strong matches, close calls, near misses, hard negatives, profiles, videos, and topic areas:

```powershell
python -m backend.tools.match_lab curate --snapshot artifacts/match-lab-snapshot.json --assessments artifacts/match-lab-assessments.json --output artifacts/match-lab-curated.json --target-count 200 --seed finite-feed-match-lab-v1
```

## 3. Export, reset, and load

The replacement command locks the Match Lab dataset, exports snapshots/pairs/reviews to a new file, deletes only `annotation_labels` and `annotation_pair_scores`, loads the curated pairs, and commits once. Set `MATCH_LAB_TARGET_ENVIRONMENT` to the database's explicit environment marker first. Inspect the non-secret target identity and copy its fingerprinted confirmation token:

```powershell
python -m backend.tools.match_lab target
```

The command refuses a missing marker, a Railway marker mismatch, a remote target without an authoritative Railway environment identity, an argument mismatch, an existing backup path, or an incorrect target-bound confirmation token.

```powershell
python -m backend.tools.match_lab replace --curated artifacts/match-lab-curated.json --backup private-backups/match-lab-before-replace.json --environment development --confirm replace-match-lab:development:<target-fingerprint>
```

Production additionally requires `--allow-production`. Inspect the backup and reported exported/deleted/loaded counts before proceeding; never point an exploratory run at production or a shared database.

Migration `0011` introduces the queue schema; `0012` supplies the sample pairs without running replacement. Preview deployments use an ephemeral signing secret when the repository secret is absent; production deployment requires an explicit `MATCH_LAB_COOKIE_SECRET` repository secret.

## Runtime identity and debug behavior

Set `MATCH_LAB_COOKIE_SECRET` to at least 32 random bytes in every deployed environment. The API issues an HTTP-only, secure, signed, two-year pseudonymous cookie; the browser never chooses the reviewer ID. Production deployments force `MATCH_LAB_DEBUG_ASSESSMENT=false`; previews may opt in with the separate `MATCH_LAB_PREVIEW_DEBUG_ASSESSMENT` repository variable. When explicitly enabled, the saved response includes predicted fit, close-call state, and the short decision summary; the UI shows it for 3.5 seconds only after the judgment is durable.
