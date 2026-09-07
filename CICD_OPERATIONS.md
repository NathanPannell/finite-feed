# CI/CD operations

Feature branches target `staging`; a separate reviewing agent checks the final head and merges passing PRs. `main` is released production and receives release PRs from `staging`. Direct pushes to either long-lived branch, including administrator bypasses, are not part of the release process.

## Integration and release review

Builders implement and test a feature in an isolated branch based on current staging. An independent agent reviews the final diff and verification evidence, records its identity and the reviewed SHA, and merges only after current checks pass and findings are resolved. Changes after review invalidate that evidence. Agents sharing one GitHub identity cannot submit formal self-approvals; record genuine independent-agent review without pretending the account supplies a second reviewer.

After the combined staging deployment settles, verify its exact API/worker commit, browser journeys, Google sign-in, migrations, and frontend version. Prepare a release PR from staging to main with the version, tested SHA, changes, and verification evidence. Keep staging fixed during final release review, or refresh all candidate evidence after another merge. The release PR is a separate decision from merging feature work; do not merge it merely because it was opened. Merge with a merge commit and retain both long-lived branches. Production hotfixes must be brought back into staging before the next release.

Staging uses a permanent Neon database/Auth branch and permanent Railway API/worker environment. PR closure and expiry cleanup must never delete or reset them. Its credentials, accounts, and data remain separate from production, and its worker must not send production Telegram messages. Register the persistent staging Google callback once; disposable PR Google callbacks remain optional.

## GitHub protection

The checked-in branch-protection policies require PRs, current checks, resolved review conversations, and enforcement for administrators; they block force pushes and deletion. Zero GitHub approvals accommodates the shared automation identity but does not waive independent agent review, PRs, or checks. Disposable preview deployment is intentionally skipped for untrusted actors, dependency bots, and release PRs using permanent staging evidence.

Apply it after the repository's GitHub plan supports private-repository branch protection:

```powershell
gh api --method PUT repos/NathanPannell/finite-feed/branches/main/protection --input .github/main-protection.json
gh api --method PUT repos/NathanPannell/finite-feed/branches/staging/protection --input .github/staging-protection.json
gh api repos/NathanPannell/finite-feed/branches/main --jq .protected
```

The September 6, 2026 attempt returned HTTP 403 with an explicit GitHub Pro/private-repository plan restriction. The policy file and agent instruction are not server-side enforcement. Keep the repository private and do not add a direct-push bypass to work around this restriction.

GitHub vulnerability alerts and automated security fixes were enabled and verified on September 6, 2026. Dependabot handles grouped weekly dependency and Actions updates; its PRs still need the ordinary checks. Preview deployment remains restricted to the configured trusted author and actor, so dependency-bot PRs do not receive deployment credentials.

## Verification boundaries

Neon preview branches already isolate database changes. Preview credential hygiene additionally removes inherited production database credentials from Railway processes; it does not replace Neon branching. Cleanup already runs on PR closure; resource metadata and aggregated errors make repeated deployments and failed runs accountable.

Close-event cleanup enumerates all tagged Vercel previews for the PR and safely handles the latest legacy bot-recorded ID. Older untagged deployments without trustworthy attribution need a separate inventory; do not guess their ownership. Failed cleanup can be rerun. A scheduled reconciliation sweep is not enabled: it must share the per-PR deployment lock and recheck closure before deleting resources, including when a PR is reopened.

Production-build browser tests and isolated session smoke checks complement backend integration tests. OAuth-start verification checks the unauthenticated provider flow; it does not prove an interactive Google login, account session, or Telegram delivery succeeded. Google sign-in must be verified on permanent staging and production. Google unavailability on disposable previews is not a failure and does not require callback registration.

The preview native-auth check uses a synthetic account to verify sign-up, session restoration, sign-out and application-account cleanup without model calls or Telegram delivery. Run workflow linting on Linux with ShellCheck available; Windows actionlint alone does not exercise the same shell checks as the GitHub runner.

Recovery rehearsal and proactive pipeline alerts remain tracked in issue #34. Never automatically roll back database migrations or restore production data from a preview.
