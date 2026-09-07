import { pathToFileURL } from "node:url";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export async function assertPreviewState(mode, environment = process.env, dependencies = {}) {
  if (mode !== "deploy" && mode !== "cleanup") throw new Error("Preview state mode must be deploy or cleanup.");

  const repository = environment.GITHUB_REPOSITORY;
  const pullRequest = environment.PREVIEW_PULL_REQUEST;
  const token = environment.GITHUB_TOKEN;
  const expectedCommit = environment.EXPECTED_COMMIT_SHA;
  if (!repository || !REPOSITORY_PATTERN.test(repository)) throw new Error("GITHUB_REPOSITORY must identify one owner and repository.");
  if (!pullRequest || !/^[1-9][0-9]*$/.test(pullRequest)) throw new Error("PREVIEW_PULL_REQUEST must be a positive integer.");
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  if (mode === "deploy" && (!expectedCommit || !SHA_PATTERN.test(expectedCommit))) {
    throw new Error("Deploy mode requires a full EXPECTED_COMMIT_SHA.");
  }

  const request = dependencies.fetch ?? fetch;
  const timeoutSignal = dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  let response;
  try {
    response = await request(`https://api.github.com/repos/${repository}/pulls/${pullRequest}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: timeoutSignal(10_000),
    });
  } catch {
    throw new Error("Could not verify the current pull request state.");
  }
  if (!response.ok) throw new Error(`Could not verify the current pull request state (HTTP ${response.status}).`);

  let pull;
  try {
    pull = await response.json();
  } catch {
    throw new Error("GitHub returned an invalid pull request response.");
  }
  if (mode === "cleanup") {
    if (pull.state !== "closed") throw new Error("Cleanup is allowed only while the pull request is currently closed.");
    return;
  }
  if (pull.state !== "open") throw new Error("Preview deployment is allowed only while the pull request is currently open.");
  if (pull.head?.sha !== expectedCommit) throw new Error("Preview deployment commit no longer matches the current pull request head.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assertPreviewState(process.argv[2]);
  console.log("Live pull request state permits this preview operation.");
}
