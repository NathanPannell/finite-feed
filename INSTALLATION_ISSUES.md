# Full-stack bootstrap installation log

This log records everything that did not run smoothly while creating Finite Feed from `NathanPannell/full-stack-app-template` on Windows on 2026-09-02.

## 1. Template repository clone raced template generation

The bootstrap cloned `NathanPannell/finite-feed` before GitHub had populated it from the template. The local checkout was empty and `.railway/railway.ts` was absent.

Workaround: wait for the generated repository's default branch, then pull `origin/main` into the existing checkout.

Suggested fix: poll until the default branch and a sentinel file exist before cloning.

## 2. Template token verification matched its own script on Windows

`scripts/customize-template.ps1` matched its own replacement map despite an `rg` exclusion glob. Filtering those matches left empty output while `rg` retained exit code 0, causing another false positive.

Workaround: filter by normalized path and require both exit code 0 and non-empty output before throwing.

Suggested fix: exclude the resolved script path before searching or search only known template files.

## 3. Neon CLI ignored JSON output for connection strings

The installed Neon CLI returned a raw `postgresql://...` string for `neon connection-string --output json`, so `ConvertFrom-Json` failed. The URL was captured without printing it.

Workaround: accept either a raw Postgres URL or the documented JSON response shape.

Suggested fix: support both formats and add a regression test.

## 4. Provider config dependencies were not installed

`neon deploy` could not evaluate `neon.ts` because `@neon/config/v1` was unavailable. The repository had a lockfile but no installed root dependencies.

Workaround: run root `npm ci` before `neon deploy`.

Suggested fix: install pinned root dependencies before invoking provider configuration.

## 5. Railway CLI was blocked by Windows security

The installed `@railway/cli` wrapper produced no output because Windows blocked `railway.exe` as a virus or potentially unwanted application. The wrapper hid the launch failure, and bootstrap later reported only a missing project ID.

Workaround: security protections were not weakened. Install Railway's official Linux CLI inside the existing Ubuntu WSL environment and invoke that binary by absolute path.

Suggested fix: require `railway --version` to emit a version at startup and preserve wrapper stderr.

## Template issue

GitHub issue: https://github.com/NathanPannell/full-stack-app-template/issues/2

## 6. Backend verification initially used the global Python environment

The first backend test run failed during collection because `pydantic-settings` was not installed globally. The template does not create a local Python environment during bootstrap.

Workaround: create the ignored `.venv`, install `backend/requirements-dev.txt`, and run tests through that interpreter.

Suggested fix: document or automate local virtual-environment creation before the first verification command.

## 7. WSL initially resolved the blocked Windows Railway wrapper

Ubuntu inherited the Windows npm directory in its `PATH`, so `command -v railway` found the unusable Windows wrapper. The wrapper then failed because Linux could not find its Windows Node runtime.

Workaround: test for and invoke `$HOME/.railway/bin/railway` explicitly rather than relying on inherited `PATH` order.

Suggested fix: document an absolute WSL binary path or sanitize `PATH` in the Windows bootstrap fallback.

## 8. Railway IaC requires Node 22 inside WSL

The official Railway binary could create the project, but `config apply` failed because Ubuntu had no Linux Node executable. Ubuntu 22.04 then installed Node 12, which does not support Railway's required type-stripping flags. Upgrading through NodeSource initially conflicted with the old `libnode-dev` package.

Workaround: run package installation non-interactively as the WSL root user, remove the obsolete Node 12 development headers, then finish installing Node 22.

Suggested fix: perform a `node --version` preflight and require Node 22 before applying the TypeScript IaC file.

## 9. An intermediary `env` process confused Railway's CLI version check

Invoking Railway as a child of Linux `env` caused the IaC package to inspect `env --version` instead of `railway --version`, incorrectly claiming that CLI 5.48 was older than 5.42.1.

Workaround: export variables in Bash and invoke the Railway binary directly.

Suggested fix: have the IaC compatibility check use an explicit CLI-provided version instead of the shell `_` variable.

## 10. A Railway failure prevented the Vercel project from being created

The bootstrap stopped at Railway and never reached its Vercel creation, linking, GitHub secret, or `BOOTSTRAP_COMPLETE` steps. The repository therefore had passing CI but no production frontend, without a prominent end-of-run inventory showing that Vercel was still missing.

Workaround: manually wire the Neon URLs into Railway, create and link the Vercel project, install the provider secrets and IDs in GitHub Actions, set `BOOTSTRAP_COMPLETE=true`, and dispatch the production workflow.

Suggested fix: make each provider stage independently resumable, persist Railway and Vercel IDs immediately, and print a final provider checklist that clearly marks incomplete resources after any failure.

## 11. Manual Railway recovery depended on the WSL user's install path

The first recovery command stored the Railway executable in a temporary shell variable that arrived empty across the PowerShell-to-WSL command boundary. A second attempt assumed the CLI was under `/root`, while the existing installation was actually `/home/nathan/.railway/bin/railway`.

Workaround: discover the existing Linux binary first and invoke `/home/nathan/.railway/bin/railway` directly.

Suggested fix: have the Windows fallback discover and validate the WSL user and Railway binary path before provider operations, then reuse that resolved path consistently.

## 12. Railway skipped recovery deployment after an earlier failure

After the database variables were fixed, the production workflow ran `railway up` for the same source commit. Railway marked the deployment `SKIPPED` because no watched files had changed, even though the previous deployment of that commit had failed, so the workflow waited for readiness without a running API.

Workaround: run `railway redeploy --from-source --yes` for both services.

Suggested fix: detect a skipped deployment when no healthy deployment exists and automatically retry with `railway redeploy --from-source` before entering the readiness loop.

## 13. Vercel project creation selected the wrong output directory

The Vercel project was created before being linked to `frontend/`, so its framework settings expected a `public` output directory. The Next.js build completed successfully, but deployment then failed because Vercel looked for that nonexistent directory.

Workaround: explicitly set `framework` to `nextjs` and `outputDirectory` to `null` in `frontend/vercel.json`, allowing Vercel to use the framework build output.

Suggested fix: create or configure the Vercel project from the frontend working directory and explicitly apply the intended framework settings before the first deployment.

## 14. Neon PR preview used database and role defaults that do not exist

The preview workflow created `preview/pr-1`, then `neondatabase/create-branch-action@v6` tried to fetch connection information for its defaults, database `neondb` and role `neondb_owner`. The template's Neon project instead creates database `app` and role `app_owner`, so the action failed with HTTP 404.

Workaround: pass `database: app` and `role: app_owner` explicitly to the branch action.

Suggested fix: keep the database and role names in shared template variables or emit them from bootstrap so production and preview workflows cannot diverge.

## 15. Railway rejected an empty value used to isolate preview secrets

The first runtime-secret preview attempted to overwrite the inherited production Telegram token with an empty value. Railway's CLI rejects empty stdin values, so preview provisioning stopped before deployment.

Workaround: inspect variable names without printing values and explicitly delete `TELEGRAM_PRODUCTION_BOT_TOKEN` from each preview service when present.

Suggested fix: use explicit deletion for secrets that must not cross an environment boundary, and verify the resulting secret-presence matrix without printing values.

## 16. Local Postgres startup collided with an existing project

The first integration-test startup could not bind host port 5432 because another Docker project already owned it. The Compose file supported `POSTGRES_PORT`, but the initial setup path did not discover or select a free port.

Workaround: start Finite Feed with `POSTGRES_PORT=55433` and point the local database URLs at that port.

Suggested fix: have bootstrap local setup probe the default port, select an available alternative, and write the chosen non-secret port into the local environment file.

## 17. The pinned frontend install emitted an unsupported ESLint warning

`npm ci` completed, but npm reported that the pinned ESLint 9.39.2 package was no longer supported.

Workaround: none was required for this run; lint, type checking, and the production build still passed.

Suggested fix: refresh the template's pinned frontend lint dependencies and verify the generated lockfile no longer installs an unsupported release.

## 18. The task opened in the static prototype instead of the deployed repository

The Codex workspace initially pointed at `youtube-digest`, which contains the early static prototype, while the deployed full-stack app lives in `finite-feed`. The first local clone attempt also hit Git's safe-directory ownership protection.

Workaround: identify the live repository from deployment history and clone its GitHub remote into the writable task workspace.

Suggested fix: have the bootstrap open or hand off to the generated app project when creation completes, and include the final local checkout path in its completion summary.

## 19. A new Railway preview had no API deployment to redeploy

The PR workflow successfully created `pr-3`, then immediately called `railway redeploy` for the API. A newly copied environment did not yet have a completed API deployment, so Railway rejected the redeploy and the preview stopped before Vercel.

Workaround: use `railway up` for both API and worker preview services so the checked-out PR source creates their first deployments.

Suggested fix: make first preview deployment consistently source-based; reserve `redeploy` for environments with a known completed deployment.
