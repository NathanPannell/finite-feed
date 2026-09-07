import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function assertProductionSource(environment = process.env, dependencies = {}) {
  const run = dependencies.execFileSync ?? execFileSync;
  const request = dependencies.fetch ?? fetch;
  const expected = environment.EXPECTED_COMMIT_SHA;
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GITHUB_TOKEN;

  if (!expected || !repository || !token) throw new Error("Deployment source guard is missing required GitHub context.");
  if (environment.GITHUB_REF !== "refs/heads/main") throw new Error("Production deployment is restricted to refs/heads/main.");

  const checkedOut = run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (checkedOut !== expected) throw new Error(`Checked-out commit ${checkedOut} does not match requested commit ${expected}.`);

  const response = await request(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`Could not resolve the current main commit (HTTP ${response.status}).`);
  const current = (await response.json()).object?.sha;
  if (current !== expected) throw new Error(`Refusing stale production commit ${expected}; main is now ${current || "unknown"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assertProductionSource();
  console.log("Production source matches the current main commit.");
}
