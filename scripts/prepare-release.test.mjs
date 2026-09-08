import assert from "node:assert/strict";
import test from "node:test";

import { prepareRelease } from "./prepare-release.mjs";

const candidate = "a".repeat(40);
const environment = {
  GITHUB_REF: "refs/heads/staging",
  GITHUB_SHA: candidate,
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_TOKEN: "user-token",
  RELEASE_CANDIDATE_SHA: candidate,
  RELEASE_PREPARATION_RUN: "77",
  RELEASE_VERSION: "0.1.0",
};
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

function dependencies(runConclusion = "success") {
  const writes = [];
  return {
    writes,
    requiredChecks: ["backend"],
    readFileSync: () => "0.1.0\n",
    fetch: async (url, options) => {
      if (url.endsWith("/git/ref/heads/staging")) return response({ object: { sha: candidate } });
      if (url.endsWith("/git/ref/tags/v0.1.0")) return response({}, 404);
      if (url.includes("/check-runs")) return response({ check_runs: [{ name: "backend", id: 1, status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.endsWith("/actions/runs/77")) return response({ event: "workflow_dispatch", head_branch: "staging", head_sha: candidate, path: ".github/workflows/release.yml", status: "completed", conclusion: runConclusion });
      if (url.includes("/pulls?")) return response([]);
      writes.push({ url, options, body: JSON.parse(options.body) });
      return response({ number: 21, ...JSON.parse(options.body) }, 201);
    },
  };
}

test("authenticated helper creates staging-to-main PR from a successful attestation", async () => {
  const deps = dependencies();
  const pull = await prepareRelease(environment, deps);
  assert.equal(pull.number, 21);
  assert.equal(deps.writes.length, 1);
  assert.deepEqual({ head: deps.writes[0].body.head, base: deps.writes[0].body.base }, { head: "staging", base: "main" });
  assert.match(deps.writes[0].body.body, new RegExp(candidate));
  assert.match(deps.writes[0].body.body, /"preparationRun":"77"/);
});

test("helper cannot open a PR from a failed preparation run", async () => {
  await assert.rejects(prepareRelease(environment, dependencies("failure")), /not completed successfully/);
});
