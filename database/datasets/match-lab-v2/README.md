# Match Lab sample v2

This sample contains 100 synthetic preference profiles, all 296 public video records in the September 4, 2026 source extraction, and 200 individually selected profile–video pairs. Every profile appears twice. The original 30 profiles retain their IDs, summaries, and topics.

The two curation files contain assistant judgments made with GPT-6 from titles and descriptions, not watched-video verification or human consensus. Their mix is 50 strong matches, 60 close calls, 40 near misses, and 50 hard negatives. Scores express judgment estimates, not calibrated probabilities. A strong match is `yes` without a close-call flag; a hard negative is `no` without that flag; a near miss is `no` with the flag; a close call is `yes` or `unsure` with the flag.

The full video inventory includes two records with empty descriptions. Selected videos have English titles and descriptions; language was not independently verified from audio. Source descriptions are retained as extracted, including publisher boilerplate. No production-user profiles or reviewer identities appear in these artifacts.

`0012_match_lab_golden_seed.sql` adds missing public videos, annotation snapshots, profiles, and curated pairs. It preserves existing source records, profile versions, annotation snapshots, and every human label. Existing labels determine consensus or escalation for seeded pairs. Source identity or pair-assessment collisions abort the transaction rather than overwrite existing data. Generated thumbnails are used only for missing public-video fixtures; existing production thumbnails remain intact.

The snapshot records the 29,600 possible profile–video combinations and the 200 selected pairs separately. Its SHA-256 covers canonical JSON of the source records, synthetic profiles, assessments, extraction time, and curation provenance. It excludes the migration source commit and migration list, which are recorded separately. Existing database snapshots may be older than the extraction; preservation is explicit in the provenance. An applied migration is immutable.

Before the migration is first applied, rebuild it with:

```powershell
python -m backend.tools.build_match_lab_seed --source-commit <merged-source-sha>
python -m pytest backend/tests/test_match_lab_seed.py
```

Database tests require a disposable local PostgreSQL URL. They build isolated schemas inside transactions and roll back; they never commit test labels. Deployment applies the checked-in migration through the normal migration runner. Verify the deployed commit, migration checksum, dataset counts, preserved labels, and a real Match Lab browser journey afterward.
