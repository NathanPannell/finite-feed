import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPreparationRun,
  assertProductionMerge,
  assertReleasePullRequest,
  assertRequiredChecks,
  parseReleaseMarker,
  releaseMarker,
} from "./release-contract.mjs";

const candidate = "a".repeat(40);
const deployed = "b".repeat(40);
const marker = { version: "0.1.0", candidate, preparationRun: "1234" };
const body = releaseMarker(marker);

test("release PR is pinned to the prepared staging head and VERSION", () => {
  assert.deepEqual(assertReleasePullRequest({ pull_request: { base: { ref: "main" }, head: { ref: "staging", sha: candidate }, body } }, "0.1.0"), marker);
  assert.throws(() => assertReleasePullRequest({ pull_request: { base: { ref: "main" }, head: { ref: "staging", sha: "c".repeat(40) }, body } }, "0.1.0"), /advanced after preparation/);
  assert.throws(() => assertReleasePullRequest({ pull_request: { base: { ref: "main" }, head: { ref: "topic", sha: candidate }, body } }, "0.1.0"), /staging directly into main/);
});

test("release marker rejects malformed or incomplete metadata", () => {
  assert.deepEqual(parseReleaseMarker(`before\n${body}\nafter`), marker);
  assert.throws(() => parseReleaseMarker("ordinary PR"), /missing its preparation marker/);
  assert.throws(() => releaseMarker({ ...marker, version: "v0.1.0" }), /without a v prefix/);
});

test("candidate requires every named successful check", () => {
  assertRequiredChecks([{ name: "ci", conclusion: "success" }, { name: "staging", conclusion: "success" }], ["ci", "staging"]);
  assert.throws(() => assertRequiredChecks([{ name: "ci", conclusion: "failure" }], ["ci", "staging"]), /ci, staging/);
});

test("production requires the exact two-parent release merge", () => {
  const pull = { merged_at: "2026-09-07", base: { ref: "main" }, head: { ref: "staging" }, merge_commit_sha: deployed, body };
  assert.deepEqual(assertProductionMerge({ expected: deployed, checkedOut: deployed, currentMain: deployed, parents: ["d".repeat(40), candidate], pullRequests: [pull], repositoryVersion: "0.1.0" }), marker);
  assert.throws(() => assertProductionMerge({ expected: deployed, checkedOut: deployed, currentMain: deployed, parents: [candidate], pullRequests: [pull], repositoryVersion: "0.1.0" }), /two-parent/);
  assert.throws(() => assertProductionMerge({ expected: deployed, checkedOut: deployed, currentMain: deployed, parents: ["d".repeat(40), "e".repeat(40)], pullRequests: [pull], repositoryVersion: "0.1.0" }), /prepared staging candidate/);
});

test("preparation run is bound to the workflow, branch, and candidate", () => {
  const run = { event: "workflow_dispatch", head_branch: "staging", head_sha: candidate, path: ".github/workflows/release.yml", status: "completed", conclusion: "success" };
  assert.doesNotThrow(() => assertPreparationRun(run, marker));
  assert.throws(() => assertPreparationRun({ ...run, head_sha: "f".repeat(40) }, marker), /does not identify/);
  assert.throws(() => assertPreparationRun({ ...run, conclusion: "failure" }, marker), /not completed successfully/);
});
