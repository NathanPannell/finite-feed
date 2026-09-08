import { pathToFileURL } from "node:url";
import {
  REQUIRED_RELEASE_CHECKS,
  assertPreparationRun,
  assertRequiredChecks,
  githubJson,
  normalizeSha,
  normalizeVersion,
  readRepositoryVersion,
  releasePullRequestBody,
  releaseTag,
  resolveTagCommit,
} from "./release-contract.mjs";

export async function validateReleaseCandidate(environment = process.env, dependencies = {}) {
  const context = { token: environment.GITHUB_TOKEN, repository: environment.GITHUB_REPOSITORY, fetchImpl: dependencies.fetch ?? fetch };
  if (!context.token || !context.repository) throw new Error("Release preparation is missing GitHub context.");
  if (environment.GITHUB_REF !== "refs/heads/staging") throw new Error("Prepare release must be dispatched from staging.");
  const version = normalizeVersion(environment.RELEASE_VERSION);
  const candidate = normalizeSha(environment.RELEASE_CANDIDATE_SHA, "Release candidate");
  if (version !== readRepositoryVersion(dependencies.readFileSync)) throw new Error("Requested release version does not match VERSION.");
  if (normalizeSha(environment.GITHUB_SHA, "Workflow commit") !== candidate) throw new Error("Dispatch ref does not match the requested release candidate.");

  const staging = await githubJson("/git/ref/heads/staging", context);
  if (normalizeSha(staging.object?.sha, "Current staging commit") !== candidate) throw new Error("Release candidate is no longer the current staging head.");
  const existingTag = await resolveTagCommit(releaseTag(version), context);
  if (existingTag) throw new Error(`${releaseTag(version)} already exists at ${existingTag}; increment VERSION before preparing another release.`);

  const checks = await githubJson(`/commits/${candidate}/check-runs?per_page=100`, context);
  assertRequiredChecks(checks.check_runs ?? [], dependencies.requiredChecks ?? REQUIRED_RELEASE_CHECKS);
  return { candidate, context, version };
}

export async function prepareRelease(environment = process.env, dependencies = {}) {
  const { candidate, context, version } = await validateReleaseCandidate(environment, dependencies);
  const runId = String(environment.RELEASE_PREPARATION_RUN ?? "");
  if (!/^\d+$/.test(runId)) throw new Error("RELEASE_PREPARATION_RUN must identify the successful manual preparation run.");
  const preparation = await githubJson(`/actions/runs/${runId}`, context);
  assertPreparationRun(preparation, { version, candidate, preparationRun: runId });

  const [owner] = context.repository.split("/");
  const openPulls = await githubJson(`/pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:staging`)}&per_page=10`, context);
  if (openPulls.length > 1) throw new Error("More than one open staging-to-main release PR exists.");
  const title = `Release ${releaseTag(version)}`;
  const body = releasePullRequestBody({ version, candidate, preparationRun: runId });
  if (openPulls[0]) {
    if (normalizeSha(openPulls[0].head?.sha, "Open release PR head") !== candidate) throw new Error("Open release PR head differs from the prepared candidate.");
    return githubJson(`/pulls/${openPulls[0].number}`, { ...context, method: "PATCH", body: { title, body } });
  }
  return githubJson("/pulls", { ...context, method: "POST", body: { title, body, head: "staging", base: "main" } });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pull = await prepareRelease();
  console.log(`Release PR #${pull.number} prepared for ${process.env.RELEASE_CANDIDATE_SHA}.`);
}
