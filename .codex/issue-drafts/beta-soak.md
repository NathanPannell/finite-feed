Deferred from #29 and #31 at the owner's explicit request: no soak testing in this implementation run.

Owner: NathanPannell (beta operator).

Acceptance criteria:
- Run an invited multi-user soak (suggested two weeks) covering Google signup, interests/exclusions, source follows, Telegram linking, scheduled delivery, feedback and subsequent selection.
- Fix reliability thresholds before starting; record due/delivered times, failures, retries, duplicates and user-visible outcomes without including sensitive content.
- Exercise restart mid-job, overlapping workers, provider 429/timeouts, model unavailable, blocked Telegram chats, duplicate webhooks and DB interruption in an isolated environment.
- Verify DST, pause/resume, missed-window behavior and multi-pick count across more than one user.
- Distinguish verified technical beta readiness from completion of the actual invited soak; do not claim the soak passed without evidence.
- Preserve preview delivery isolation and document Telegram's irreducible send-success/DB-commit-failure duplicate window.
