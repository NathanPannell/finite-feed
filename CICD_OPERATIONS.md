# CI/CD operations

Agents push feature branches and merge passing PRs. Direct pushes to `main`, including administrator bypasses, are not part of the release process.

## GitHub protection

`.github/main-protection.json` requires a PR, up-to-date passing `backend`, `frontend` and `deployment-contracts` checks, resolved review conversations, and enforcement for administrators. It blocks force pushes and deletion. Zero required approvals deliberately allows agents to merge without a human reviewer; it does not waive the PR or checks.

Apply it after the repository's GitHub plan supports private-repository branch protection:

```powershell
gh api --method PUT repos/NathanPannell/finite-feed/branches/main/protection --input .github/main-protection.json
gh api repos/NathanPannell/finite-feed/branches/main --jq .protected
```

The September 6, 2026 attempt returned HTTP 403 with an explicit GitHub Pro/private-repository plan restriction. The policy file and agent instruction are not server-side enforcement. Keep the repository private and do not add a direct-push bypass to work around this restriction.

GitHub vulnerability alerts and automated security fixes were enabled and verified on September 6, 2026. Dependabot handles grouped weekly dependency and Actions updates; its PRs still need the ordinary checks. Preview deployment remains restricted to the configured trusted author and actor, so dependency-bot PRs do not receive deployment credentials.

## Verification boundaries

Neon preview branches already isolate database changes. Preview credential hygiene additionally removes inherited production database credentials from Railway processes; it does not replace Neon branching. Cleanup already runs on PR closure; resource metadata and aggregated errors make repeated deployments and failed runs accountable.

Close-event cleanup enumerates all tagged Vercel previews for the PR and safely handles the latest legacy bot-recorded ID. Older untagged deployments without trustworthy attribution need a separate inventory; do not guess their ownership. Failed cleanup can be rerun. A scheduled reconciliation sweep is not enabled: it must share the per-PR deployment lock and recheck closure before deleting resources, including when a PR is reopened.

Production-build browser tests and isolated preview smoke checks complement backend integration tests. OAuth-start verification establishes that the provider accepts the callback; it does not prove an interactive Google login, account session, or Telegram delivery succeeded. Those journeys require an authorized test account and controlled delivery conditions.

Recovery rehearsal and proactive pipeline alerts remain tracked in issue #34. Never automatically roll back database migrations or restore production data from a preview.
