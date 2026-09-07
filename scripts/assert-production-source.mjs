import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertPreparationRun,
  assertProductionMerge,
  githubJson,
  readRepositoryVersion,
  releaseTag,
  resolveTagCommit,
} from "./release-contract.mjs";

export async function assertProductionSource(environment = process.env, dependencies = {}) {
  const run = dependencies.execFileSync ?? execFileSync;
  const request = dependencies.fetch ?? fetch;
  const expected = environment.EXPECTED_COMMIT_SHA;
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GITHUB_TOKEN;

  if (!expected || !repository || !token) throw new Error("Deployment source guard is missing required GitHub context.");
  if (environment.GITHUB_REF !== "refs/heads/main") throw new Error("Production deployment is restricted to refs/heads/main.");

  const checkedOut = run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const parents = run("git", ["show", "-s", "--format=%P", "HEAD"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  const context = { token, repository, fetchImpl: request };
  const main = await githubJson("/git/ref/heads/main", context);
  const pulls = await githubJson(`/commits/${expected}/pulls`, context);
  const marker = assertProductionMerge({
    expected,
    checkedOut,
    parents,
    currentMain: main.object?.sha,
    pullRequests: pulls,
    repositoryVersion: readRepositoryVersion(dependencies.readFileSync),
  });
  const preparation = await githubJson(`/actions/runs/${marker.preparationRun}`, context);
  assertPreparationRun(preparation, marker);
  const taggedCommit = await resolveTagCommit(releaseTag(marker.version), context);
  if (taggedCommit && taggedCommit !== expected) throw new Error(`Release tag ${releaseTag(marker.version)} already points to a different commit.`);
  return marker;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assertProductionSource();
  console.log("Production source matches the current main commit.");
}
