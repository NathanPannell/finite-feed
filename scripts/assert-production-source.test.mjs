import assert from "node:assert/strict";
import test from "node:test";

import { assertProductionSource } from "./assert-production-source.mjs";
import { releaseMarker } from "./release-contract.mjs";

const candidate = "a".repeat(40);
const expected = "b".repeat(40);
const parent = "c".repeat(40);
const marker = { version: "0.1.0", candidate, preparationRun: "42" };
const environment = {
  EXPECTED_COMMIT_SHA: expected,
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_TOKEN: "token",
  GITHUB_REF: "refs/heads/main",
};

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function dependencies(overrides = {}) {
  return {
    readFileSync: () => "0.1.0\n",
    execFileSync: (_command, args) => args[0] === "rev-parse" ? `${expected}\n` : `${parent} ${candidate}\n`,
    fetch: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: expected } });
      if (url.endsWith(`/commits/${expected}/pulls`)) return response([{ merged_at: "now", base: { ref: "main" }, head: { ref: "staging" }, merge_commit_sha: expected, body: releaseMarker(marker) }]);
      if (url.endsWith("/actions/runs/42")) return response({ event: "workflow_dispatch", head_branch: "staging", head_sha: candidate, path: ".github/workflows/release.yml", status: "completed", conclusion: "success" });
      if (url.includes("/git/ref/tags/")) return response({}, 404);
      throw new Error(`Unexpected URL ${url}`);
    },
    ...overrides,
  };
}

test("accepts the exact prepared staging merge at current main", async () => {
  assert.deepEqual(await assertProductionSource(environment, dependencies()), marker);
});

test("rejects a manual dispatch from a non-main ref before querying GitHub", async () => {
  let queried = false;
  await assert.rejects(assertProductionSource({ ...environment, GITHUB_REF: "refs/heads/topic" }, dependencies({ fetch: async () => { queried = true; return response({}); } })), /restricted to refs\/heads\/main/);
  assert.equal(queried, false);
});

test("rejects a main commit without the prepared staging parent", async () => {
  await assert.rejects(assertProductionSource(environment, dependencies({ execFileSync: (_command, args) => args[0] === "rev-parse" ? expected : `${parent} ${"d".repeat(40)}` })), /prepared staging candidate/);
});
