# Match Lab launch preparation — 2026-09-04

Goal: merge PRs 20, 22, 23, 24; seed 100 synthetic profiles, a snapshot of all production videos, and 200 individually curated pairs through an append-only migration; verify deployment and draft a launch-readiness issue for approval.

Completed: read repository operational and deployment guidance; all four requested PRs have successful backend/frontend CI and previews at their current heads. Working tree is clean on main.

Decisions: preserve existing production data and annotations; do not merge unrequested PR 21 without authorization. Investigate whether its draft dataset tooling is needed. Labels must be transparently identified as assistant-curated, pending human review.

Active: independent dataset/schema reconnaissance and shared-file integration review. Parent owns merges and deployment. Use exact commit readiness, relevant automated checks, independent quality review, and real desktop/mobile browser verification.

Next: merge requested PRs in order, resolving and testing integration conflicts; inspect production snapshot and prepare seed migration.

Milestone: PRs20,22,23,24 merged (ab1e3a2, c702df6, e8ecca7, c99a5fd). User explicitly added PR21. Integrated its identity/consensus queue with English filtering and existing intro/review routes;108backend tests passed against isolated local Postgres and8browser tests passed. UUID export correction applied at517da7399a8f1634960ec12775397987c3888afd.

Dataset: immutable source snapshot extracted2026-09-04T23:47:39Z:296videos,30existing profiles;200 individually assessed pairs across100profiles/100distinct selected videos; all selected videos pass app English eligibility. Seed builder and preservation tests in progress; no production seed mutation yet.

Test workflow correction: finish dependency-install/test processes before switching the checkout they read. An install followed by tests overlapped a branch switch and produced transient conflict-marker collection errors; final database-backed rerun passed108/108. Keep subsequent validation on a stable checkout until processes exit.

Next: generate additive0012, independently review, updatePR21/pushCI, merge/deploy, verify exact readiness and production counts, desktop/mobile browser review, issue draft approval.

Seed and review milestone:0012generated, SHA25614b48af8866f8a6cedad36a8935d15ba06315b4fb337f5961f329e5cabd262fd. Full116backend DB tests passed;6seedtests prove fresh/replay/9labelpreservation/collisionrollback. Independent quality review passed29targetedtests and4workflowtests; reviewed12curationexamples grounded. Only blocking finding409stale-card recovery now being fixed with browser regression tests.

Deployment:production24run33931421821 failed at2026-09-05T00:01:08Z with Railway45min rate limit. Batched config helper now reduces initial writes36→2, preserves preview isolation. Cooldown elapsed by00:54UTC resume. Production currently296videos30profiles9labels0pairs,migrations through0010. Existing9labels digestc9e1bf6ecbcb3c9c5d4a1376539c2dab; source vsannotationtitles/descriptions identical.

Local realbrowser evidence390x844: nohorizontaloverflow; actionbeginsY1124; aftersave scroll946→962,newprofiletop-841,focusBODY; nextstreamingdescriptionclippedwithouttoggle. These remain proposed launchUI issue changes. Localbrowser save only used isolatedmatch_lab_review database, no production labels.

Resume milestone: PR21 verified remote branch is codex/issue-18-match-queue; local integration branch codex/merge-21-launch. Always resolve headRefName via gh before pushing, never infer it from task title. An unintended duplicate branch was immediately removed; PR21 now head5d3fff7.
Fresh-seed regression: prior116pass used a database previously emptied by tests. Fresh CI exposed missing video content_fingerprint; builder now uses ingestion SHA256(title + newline + description). New independent all-migrations fresh DB launch_final_verified passed116/116. Regenerated0012 dataset digestbdd48841fffdfcac37672c12718d7ad51acce754d6aed3f50bd6649c993e1741. Both Neon branches confirm0012unapplied; immutable0010/0011checksums match.
Issue draft: docs/match-lab-launch-issue.md prepared, awaiting final deployed-browser evidence and user approval before GitHub creation.
Preview diagnosis: Neon preview/pr-21 contains45public videos independently ingested with same YouTube IDs but different UUIDs; source-UUID collision guard blocked0012. Resolve aliases by unique youtube_video_id while preserving rows/references and sourcehash; reject actual UUID/wrongYouTube conflicts. Initial correctedCI33935270654 passed; preview33935270653 failed pending identitymapping. Runtime logs unavailable through unauthenticated localRailwayCLI; safer read-onlyNeon comparison established deterministic cause. RootCUA works.
Independent concurrency review: annotation submit holds pair RowShare/row lock before labels; final seed locks videos SRX, pair scores EXCLUSIVE, then labels SRX to drain in-flight submits. Two-connection regression proves wait/commit/preservation. Preview37a6ff9 applieddraft0012 justafterworkflowcancellation; preserved that test DB as preview/pr-21-before-lock-review (br-crimson-haze-arla6baz, existing7dayexpiry) so nextworkflow creates fresh preview/pr-21 for final draft. Production0012remainsunapplied; historical applieddraft retained at37a6ff9.
