import { pathToFileURL } from "node:url";

export const REQUIRED_STAGING_JOBS = new Set([
  "backend",
  "backend-docker-runtime",
  "frontend",
  "deployment-contracts",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function required(environment, key) {
  if (!environment[key]) throw new Error(`Missing required variable: ${key}`);
  return environment[key];
}

async function responseJson(fetchImpl, url, token, timeoutSignal, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: timeoutSignal(10_000),
    });
  } catch {
    throw new Error(`Could not read ${label}.`);
  }
  if (!response.ok) throw new Error(`Could not read ${label} (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
}

function latestExactRun(runs, expectedSha) {
  return runs
    .filter((run) => run?.head_sha === expectedSha && run?.head_branch === "staging" && run?.event === "push")
    .sort((left, right) => (right.run_attempt ?? 0) - (left.run_attempt ?? 0) || (right.id ?? 0) - (left.id ?? 0))[0];
}

export async function waitForStagingCi(environment = process.env, dependencies = {}) {
  const repository = required(environment, "GITHUB_REPOSITORY");
  const expectedSha = required(environment, "EXPECTED_COMMIT_SHA");
  const token = required(environment, "GITHUB_TOKEN");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("GITHUB_REPOSITORY must identify one owner and repository.");
  if (!SHA_PATTERN.test(expectedSha)) throw new Error("EXPECTED_COMMIT_SHA must be a full Git SHA.");
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutSignal = dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const maxAttempts = dependencies.maxAttempts ?? 180;
  const delayMs = dependencies.delayMs ?? 10_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("delayMs must be a non-negative integer.");

  const runsUrl = `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=staging&event=push&head_sha=${expectedSha}&per_page=20`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const listing = await responseJson(fetchImpl, runsUrl, token, timeoutSignal, "staging CI runs");
    if (!Array.isArray(listing?.workflow_runs)) throw new Error("GitHub returned an invalid staging CI run listing.");
    const run = latestExactRun(listing.workflow_runs, expectedSha);
    if (run?.status === "completed" && run.conclusion !== "success") {
      throw new Error(`Current staging CI concluded ${run.conclusion || "without success"}; refusing deployment.`);
    }
    if (run?.status === "completed" && run.conclusion === "success") {
      if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error("Current staging CI run has an invalid ID.");
      const jobs = await responseJson(
        fetchImpl,
        `https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        token,
        timeoutSignal,
        "staging CI jobs",
      );
      if (!Array.isArray(jobs?.jobs)) throw new Error("GitHub returned an invalid staging CI job listing.");
      const latestByName = new Map();
      for (const job of jobs.jobs) {
        if (!REQUIRED_STAGING_JOBS.has(job?.name)) continue;
        const previous = latestByName.get(job.name);
        if (!previous || (job.id ?? 0) > (previous.id ?? 0)) latestByName.set(job.name, job);
      }
      const missing = [...REQUIRED_STAGING_JOBS].filter((name) => latestByName.get(name)?.conclusion !== "success");
      if (missing.length) throw new Error(`Current staging CI is missing successful required jobs: ${missing.join(", ")}.`);
      return { runId: run.id, runAttempt: run.run_attempt ?? 1 };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  throw new Error("Timed out waiting for the current staging commit's CI run.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await waitForStagingCi();
    console.log(`Required staging CI jobs passed in run ${result.runId}, attempt ${result.runAttempt}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
