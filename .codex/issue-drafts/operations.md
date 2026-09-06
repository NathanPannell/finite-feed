Deferred operational validation from #29/#31; implementation supplies recovery instructions, runtime safeguards and worker status, but rehearsal and proactive notifications require separate work.

Owner: NathanPannell (operations).

Acceptance criteria:
- Restore a recent backup into an isolated Neon branch and verify migrations, account isolation, preferences, recommendation history and worker behavior without production Telegram sends.
- Rehearse application rollback against compatible additive migrations and record exact commits, recovery timing and evidence.
- Wire actionable stale-worker, overdue-delivery, sync failure and provider-budget alerts with bounded notifications and documented ownership.
- Validate provider quota settings against actual beta volume; tune bounded retry and admission controls with observed use.
- Replace process-local anonymous request ceilings with shared distributed limits if scaling beyond the initial private-beta instance; verify proxy identity trust before per-IP limits.
- Review retained data and backup expiration against published privacy behavior; confirm safe retry and delivery kill-switch procedures.
- Periodically recheck older known video IDs for private/deleted/unavailable status even when they disappear from upload playlists; verify such videos cannot be newly selected or delivered. Current ingestion disables IDs it observes missing, but cannot infer omitted historical uploads.
