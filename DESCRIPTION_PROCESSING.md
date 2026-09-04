# Description processing

Finite Feed keeps YouTube titles and descriptions unchanged in `videos` and
`annotation_videos`. A deterministic derived description is used for semantic
embeddings, legacy keyword scoring, model reranking, and Match Lab display.

## Rules

The processor normalizes HTML, mojibake, Unicode, control characters, and
whitespace. It removes chapter/timestamp lines, sponsorship and call-to-action
lines, standard TED/TEDx boilerplate, URLs, and hashtag markers. A standalone
link, hashtag block, or recognized promotion ends the description only after
useful prose has already appeared. Inline links and hashtags are removed from
their sentence without discarding the surrounding prose. If nothing useful
remains, the derived description is the empty string.

Semantic fingerprints include `description-v1`, so deployment makes vectors
built from older raw descriptions stale and the existing backfill rebuilds
them. The underlying source fingerprint and metadata remain unchanged.

## Match Lab language eligibility

Match Lab classifies the normalized title plus cleaned description with the
local `langdetect` package and a fixed seed. Non-Latin scripts are rejected
before classification. Very short Latin-script metadata is retained because
statistical language identification is unreliable at that length. This filter
is applied when selecting, counting, and accepting Match Lab pairs; it does not
delete records or affect production recommendation eligibility.

The tradeoff is deliberate: deterministic line rules can miss novel promotion
phrasing, and a promotion-like sentence on its own line can be removed even if
it is topical. Language detection can also confuse closely related languages or
code-switched text. Those cases favor stable, inspectable behavior over a remote
model call.

## Evaluation

`python -m backend.evals.run_description_cleanup_eval` exercises eight
sanitized cases representative of current TED/TEDx description shapes: useful
prose followed by promotions, inline links and hashtags, chapters, sponsorship,
boilerplate-only text, Spanish, French, and Japanese metadata. The fixtures live
in `backend/evals/description_cases.json` and are also enforced by pytest.
