# Description processing

Finite Feed keeps YouTube titles and descriptions unchanged in `videos` and
`annotation_videos`. A deterministic derived description is used for semantic
embeddings, legacy keyword scoring, model reranking, and Match Lab display.

## Rules

The processor normalizes HTML, mojibake, Unicode, control characters, and
whitespace. It removes chapter/timestamp lines, sponsorship and call-to-action
lines, standard TED/TEDx boilerplate, URLs, and hashtag markers. A hashtag block
or recognized promotion ends the description only after useful prose has
already appeared. Standalone source links are skipped without truncating later
prose, and inline sponsorship tails are removed without losing the preceding
sentence. Inline links and hashtags are removed from their sentence without
discarding the surrounding prose. If nothing useful remains, the derived
description is the empty string.

Semantic fingerprints include `description-v2`, so deployment makes vectors
built from older raw descriptions stale and the existing backfill rebuilds
them. The underlying source fingerprint and metadata remain unchanged.

## Match Lab language eligibility

Match Lab first uses YouTube's canonical `defaultAudioLanguage`, then
`defaultLanguage`, when either is available. Otherwise it classifies the
normalized title plus cleaned description with the local `langdetect` package
and a fixed seed. Non-Latin scripts are rejected before classification. Short
unknown Latin-script metadata must either classify as English or contain an
explicit common English function word; it is no longer admitted merely for
being short. This filter is applied when selecting, counting, and accepting
Match Lab pairs; it does not delete records or affect production recommendation
eligibility.

The tradeoff is deliberate: deterministic line rules can miss novel promotion
phrasing, and a promotion-like sentence on its own line can be removed even if
it is topical. Language detection can also confuse closely related languages or
code-switched text. Those cases favor stable, inspectable behavior over a remote
model call.

## Evaluation

The original representative review inspected 50 of the most recently updated,
non-empty video descriptions and retained eight distinct boundary shapes. The
selection query was:

```sql
SELECT channel_name, title, description, updated_at
FROM videos
WHERE NULLIF(BTRIM(description), '') IS NOT NULL
ORDER BY updated_at DESC, id
LIMIT 50;
```

Raw database and YouTube IDs were not retained. Each fixture instead carries a
stable sanitized `source_ref` (`current-sample-*` for the eight reviewed shapes,
`regression-*` for synthetic bug reproductions), and the evaluator rejects
missing or duplicate references. `python -m backend.evals.run_description_cleanup_eval`
now exercises 15 cases covering the original shapes plus standalone sources,
inline sponsorship, short French/Spanish/English text, and YouTube language-hint
precedence. The fixtures live in `backend/evals/description_cases.json` and are
also enforced by pytest.
