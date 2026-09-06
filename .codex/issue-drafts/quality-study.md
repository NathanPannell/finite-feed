Deferred from #30 and #31 to prioritize immediate product features over an extensive metrics/evaluation project.

Owner: NathanPannell (product/quality).

Acceptance criteria:
- Produce a versioned human-scored dataset from Match Lab with explicit human/synthetic/assistant provenance, separate tuning and held-out acceptance splits, model and embedding versions.
- Fix thresholds before scoring and compare complete retrieval-to-selection performance with baseline across cold start, niche profiles, explicit exclusions, sparse descriptions, repetition/diversity, abstention and explanation grounding.
- Demonstrate improvement from real beta feedback; never label assistant-curated or smoke-test judgments as human gold.
- Capture activation, delivery timeliness/retries/duplicates, source coverage/freshness, and user-rated usefulness with retention-conscious data collection.
- Keep clicks distinct from confirmed watching and inspect feedback's contribution to ranking.
- Existing live-evaluation failure must exit nonzero; that inexpensive repair remains in this implementation, not deferred here.
