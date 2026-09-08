import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_STAGING_JOBS, waitForStagingCi } from "./wait-for-staging-ci.mjs";

const sha = "a".repeat(40);
const environment = { GITHUB_REPOSITORY: "owner/repository", EXPECTED_COMMIT_SHA: sha, GITHUB_TOKEN: "token" };
const jobs = [...REQUIRED_STAGING_JOBS].map((name, index) => ({ id: index + 1, name, status: "completed", conclusion: "success" }));

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function run(overrides = {}) {
  return { id: 42, run_attempt: 1, head_sha: sha, head_branch: "staging", event: "push", status: "completed", conclusion: "success", ...overrides };
}

test("accepts all required jobs from the latest exact staging push run", async () => {
  const urls = [];
  const result = await waitForStagingCi(environment, {
    timeoutSignal: () => undefined,
    fetch: async (url) => {
      urls.push(url);
      return url.includes("/jobs?") ? json({ jobs }) : json({ workflow_runs: [run()] });
    },
  });
  assert.deepEqual(result, { runId: 42, runAttempt: 1 });
  assert.match(urls[0], /workflows\/ci\.yml\/runs\?.*head_sha=/);
  assert.match(urls[1], /actions\/runs\/42\/jobs\?filter=latest/);
});

test("waits for the exact current SHA rather than accepting another successful run", async () => {
  let listings = 0;
  let sleeps = 0;
  const result = await waitForStagingCi(environment, {
    maxAttempts: 2, delayMs: 0, timeoutSignal: () => undefined,
    sleep: async () => { sleeps += 1; },
    fetch: async (url) => {
      if (url.includes("/jobs?")) return json({ jobs });
      listings += 1;
      return json({ workflow_runs: listings === 1 ? [run({ head_sha: "b".repeat(40) })] : [run()] });
    },
  });
  assert.equal(result.runId, 42);
  assert.equal(sleeps, 1);
});

test("latest failed rerun cannot be masked by an older success", async () => {
  await assert.rejects(waitForStagingCi(environment, {
    timeoutSignal: () => undefined,
    fetch: async () => json({ workflow_runs: [run(), run({ id: 43, run_attempt: 2, conclusion: "failure" })] }),
  }), /concluded failure/);
});

test("fails when a successful workflow lacks any required successful job", async () => {
  await assert.rejects(waitForStagingCi(environment, {
    timeoutSignal: () => undefined,
    fetch: async (url) => url.includes("/jobs?")
      ? json({ jobs: jobs.filter((job) => job.name !== "frontend") })
      : json({ workflow_runs: [run()] }),
  }), /frontend/);
});

test("times out without an exact run and sanitizes API failures", async () => {
  await assert.rejects(waitForStagingCi(environment, {
    maxAttempts: 1, delayMs: 0, timeoutSignal: () => undefined,
    fetch: async () => json({ workflow_runs: [] }),
  }), /Timed out/);
  await assert.rejects(waitForStagingCi(environment, {
    timeoutSignal: () => undefined,
    fetch: async () => { throw new Error("secret upstream response"); },
  }), /Could not read staging CI runs/);
});
