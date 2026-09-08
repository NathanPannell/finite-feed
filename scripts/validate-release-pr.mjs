import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPreparationRun, assertReleasePullRequest, githubJson, normalizeSha, readRepositoryVersion } from "./release-contract.mjs";

export async function validateReleasePullRequest(environment = process.env, dependencies = {}) {
  const read = dependencies.readFileSync ?? readFileSync;
  const event = JSON.parse(read(environment.GITHUB_EVENT_PATH, "utf8"));
  const marker = assertReleasePullRequest(event, readRepositoryVersion(dependencies.readFileSync));
  const context = { token: environment.GITHUB_TOKEN, repository: environment.GITHUB_REPOSITORY, fetchImpl: dependencies.fetch ?? fetch };
  const staging = await githubJson("/git/ref/heads/staging", context);
  if (normalizeSha(staging.object?.sha, "Current staging commit") !== marker.candidate) throw new Error("Staging moved after release preparation.");

  const attempts = dependencies.attempts ?? 19;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await githubJson(`/actions/runs/${marker.preparationRun}`, context);
    try {
      assertPreparationRun(run, marker);
      return marker;
    } catch (error) {
      if (run.status === "completed" || attempt === attempts - 1) throw error;
      await (dependencies.delay ?? delay)(5000);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const marker = await validateReleasePullRequest();
  console.log(`Release PR is pinned to ${marker.candidate} for v${marker.version}.`);
}
