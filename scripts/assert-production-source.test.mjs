import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("rejects a shallow checkout that cannot expose both merge parents", async () => {
  await assert.rejects(assertProductionSource(environment, dependencies({ execFileSync: (_command, args) => args[0] === "rev-parse" ? expected : `${parent}` })), /two-parent merge commit/);
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createReleaseHistory() {
  const root = mkdtempSync(join(tmpdir(), "finite-feed-release-history-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const shallow = join(root, "shallow");
  const complete = join(root, "complete");
  git(root, ["init", "--initial-branch=main", source]);
  git(source, ["config", "user.email", "test@example.test"]);
  git(source, ["config", "user.name", "Finite Feed test"]);
  writeFileSync(join(source, "fixture"), "base\n");
  git(source, ["add", "fixture"]);
  git(source, ["commit", "-m", "base"]);
  git(source, ["checkout", "-b", "staging"]);
  writeFileSync(join(source, "staging-fixture"), "staging\n");
  git(source, ["add", "staging-fixture"]);
  git(source, ["commit", "-m", "staging candidate"]);
  const candidate = git(source, ["rev-parse", "HEAD"]);
  git(source, ["checkout", "main"]);
  writeFileSync(join(source, "main-fixture"), "main\n");
  git(source, ["add", "main-fixture"]);
  git(source, ["commit", "-m", "main parent"]);
  git(source, ["merge", "--no-ff", "staging", "-m", "release merge"]);
  const expected = git(source, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", source, remote]);
  const remoteUrl = pathToFileURL(remote).href;
  git(root, ["clone", "--depth=1", "--no-local", remoteUrl, shallow]);
  git(root, ["clone", "--depth=2", "--no-local", remoteUrl, complete]);
  return { root, shallow, complete, expected, candidate };
}

function realGitDependencies(directory, { expected: commit, candidate: stagingCandidate }) {
  const release = { version: "0.1.0", candidate: stagingCandidate, preparationRun: "42" };
  return dependencies({
    execFileSync: (command, args, options) => execFileSync(command, args, { ...options, cwd: directory }),
    fetch: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: commit } });
      if (url.endsWith(`/commits/${commit}/pulls`)) return response([{ merged_at: "now", base: { ref: "main" }, head: { ref: "staging" }, merge_commit_sha: commit, body: releaseMarker(release) }]);
      if (url.endsWith("/actions/runs/42")) return response({ event: "workflow_dispatch", head_branch: "staging", head_sha: stagingCandidate, path: ".github/workflows/release.yml", status: "completed", conclusion: "success" });
      if (url.includes("/git/ref/tags/")) return response({}, 404);
      throw new Error(`Unexpected URL ${url}`);
    },
  });
}

test("requires checkout history that exposes the real release merge parents", async () => {
  const history = createReleaseHistory();
  const realEnvironment = { ...environment, EXPECTED_COMMIT_SHA: history.expected };
  try {
    const shallowParents = git(history.shallow, ["show", "-s", "--format=%P", "HEAD"]);
    const completeParents = git(history.complete, ["show", "-s", "--format=%P", "HEAD"]);
    assert.equal(shallowParents, "");
    assert.equal(completeParents.split(/\s+/).length, 2);
    assert.deepEqual(
      await assertProductionSource(realEnvironment, realGitDependencies(history.complete, history)),
      { version: "0.1.0", candidate: history.candidate, preparationRun: "42" },
    );
    await assert.rejects(assertProductionSource(realEnvironment, realGitDependencies(history.shallow, history)), /two-parent merge commit/);
  } finally {
    rmSync(history.root, { recursive: true, force: true });
  }
});
