import assert from "node:assert/strict";
import test from "node:test";

import { assertPreviewState } from "./assert-preview-state.mjs";

const commit = "a".repeat(40);
const environment = {
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_TOKEN: "secret-token",
  PREVIEW_PULL_REQUEST: "42",
  EXPECTED_COMMIT_SHA: commit,
};

function dependencies(pull, { ok = true, status = 200 } = {}) {
  return {
    timeoutSignal: (milliseconds) => {
      assert.equal(milliseconds, 10_000);
      return "bounded-signal";
    },
    fetch: async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/owner/repository/pulls/42");
      assert.equal(options.signal, "bounded-signal");
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      return { ok, status, json: async () => pull };
    },
  };
}

test("deploy permits the current open pull request head", async () => {
  await assertPreviewState("deploy", environment, dependencies({ state: "open", head: { sha: commit } }));
});

test("cleanup permits a currently closed pull request", async () => {
  await assertPreviewState("cleanup", environment, dependencies({ state: "closed", head: { sha: commit } }));
});

test("deploy rejects a pull request that closed after the workflow started", async () => {
  await assert.rejects(
    assertPreviewState("deploy", environment, dependencies({ state: "closed", head: { sha: commit } })),
    /currently open/,
  );
});

test("cleanup rejects a pull request that reopened after the workflow started", async () => {
  await assert.rejects(
    assertPreviewState("cleanup", environment, dependencies({ state: "open", head: { sha: commit } })),
    /currently closed/,
  );
});

test("deploy rejects a stale pull request head", async () => {
  await assert.rejects(
    assertPreviewState("deploy", environment, dependencies({ state: "open", head: { sha: "b".repeat(40) } })),
    /no longer matches/,
  );
});

test("fails closed on GitHub API errors without exposing the token", async () => {
  await assert.rejects(
    assertPreviewState("cleanup", environment, dependencies({}, { ok: false, status: 503 })),
    (error) => error.message.includes("HTTP 503") && !error.message.includes(environment.GITHUB_TOKEN),
  );
});

test("rejects malformed repository and pull request context before the request", async () => {
  let requested = false;
  const deps = { fetch: async () => { requested = true; } };
  await assert.rejects(assertPreviewState("cleanup", { ...environment, GITHUB_REPOSITORY: "unsafe" }, deps), /GITHUB_REPOSITORY/);
  await assert.rejects(assertPreviewState("cleanup", { ...environment, PREVIEW_PULL_REQUEST: "0" }, deps), /PREVIEW_PULL_REQUEST/);
  assert.equal(requested, false);
});

test("fails closed when the request times out", async () => {
  await assert.rejects(
    assertPreviewState("cleanup", environment, {
      timeoutSignal: () => "bounded-signal",
      fetch: async () => { throw new Error("secret-token network detail"); },
    }),
    (error) => error.message === "Could not verify the current pull request state.",
  );
});
