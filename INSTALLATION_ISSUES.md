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
