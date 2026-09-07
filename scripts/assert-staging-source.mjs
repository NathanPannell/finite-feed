import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function assertStagingSource(environment = process.env, dependencies = {}) {
  const expected = environment.EXPECTED_COMMIT_SHA;
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GITHUB_TOKEN;
  if (environment.GITHUB_REF !== "refs/heads/staging") throw new Error("Staging deployment requires refs/heads/staging.");
  if (!expected || !SHA_PATTERN.test(expected)) throw new Error("EXPECTED_COMMIT_SHA must be a full Git SHA.");
  if (!repository || !REPOSITORY_PATTERN.test(repository)) throw new Error("GITHUB_REPOSITORY must identify one owner and repository.");
  if (!token) throw new Error("GITHUB_TOKEN is required.");

  const currentCheckout = dependencies.currentCheckout ?? (() => execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  }).trim());
  if (currentCheckout() !== expected) throw new Error("Checked-out source does not match the intended staging commit.");

  const request = dependencies.fetch ?? fetch;
  const timeoutSignal = dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  let response;
  try {
    response = await request(`https://api.github.com/repos/${repository}/git/ref/heads/staging`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: timeoutSignal(10_000),
    });
  } catch {
    throw new Error("Could not verify the current staging branch head.");
  }
  if (!response.ok) throw new Error(`Could not verify the current staging branch head (HTTP ${response.status}).`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub returned an invalid staging branch response.");
  }
  const current = payload?.object?.sha;
  if (current !== expected) throw new Error(`Refusing stale staging commit ${expected}; staging is now ${current || "unknown"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assertStagingSource();
  console.log("Current staging branch head matches the checked-out deployment source.");
}
