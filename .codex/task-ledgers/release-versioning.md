# Release versioning

Goal: add a guarded staging-to-main release flow whose production tag identifies the exact verified deployed commit, and expose build metadata in the frontend.

Success conditions:
- CI covers staging, main, feature PRs, and release PRs without disposable release previews.
- A manual preparation run freezes a tested staging SHA and version in a staging-to-main PR.
- Production accepts only the prepared merge and creates an idempotent release after verification.
- Staging and production show distinct version/environment/commit metadata with safe local fallbacks.

Decisions:
- Metadata contract: `NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_APP_COMMIT`.
- Initial version is `0.1.0`; release tag is `v0.1.0`.
- A release PR remains based on the long-lived `staging` branch; its validation fails if staging advances beyond the prepared SHA.

Completed:
- Added exact candidate attestation, authenticated PR preparation, release PR validation, production merge validation, and post-verification idempotent publication.
- Scoped disposable previews to feature PRs targeting staging and expanded CI to both long-lived branches and their PRs.
- Added build metadata artifact/footer and protected stable-staging admin routing.

Evidence:
- 94 repository JavaScript contract tests passed (one existing skipped test).
- Frontend lint, typecheck, 22 focused Node tests, production build, and five responsive/version browser tests passed.
- Actionlint passed every workflow; the Impeccable detector reported no findings.
- Built staging `/api/version` and footer both reported version 0.1.0 and the expected staging commit.
- Independent review found and the builder fixed stale-main promotion races, stale metadata caching, and older-success check masking; source is revalidated before frontend promotion and release publication, metadata is uncached, and only the latest trusted check result counts.

Next action: independent combined review, then merge this implementation to staging and verify the live stable staging deployment before attesting the first release candidate.
