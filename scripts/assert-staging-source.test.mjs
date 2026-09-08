import assert from "node:assert/strict";
import test from "node:test";
import { assertStagingSource } from "./assert-staging-source.mjs";

const sha = "a".repeat(40);
const environment = {
  EXPECTED_COMMIT_SHA: sha,
  GITHUB_REF: "refs/heads/staging",
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_TOKEN: "token",
};

function dependencies(branchSha = sha, checkoutSha = sha) {
  return {
    currentCheckout: () => checkoutSha,
    timeoutSignal: () => undefined,
    fetch: async () => new Response(JSON.stringify({ object: { sha: branchSha } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  };
}

test("accepts only the exact checked-out current staging head", async () => {
  await assert.doesNotReject(assertStagingSource(environment, dependencies()));
  await assert.rejects(assertStagingSource(environment, dependencies("b".repeat(40))), /Refusing stale staging commit/);
  await assert.rejects(assertStagingSource(environment, dependencies(sha, "b".repeat(40))), /Checked-out source/);
});

test("rejects non-staging refs before contacting GitHub", async () => {
  let fetched = false;
  await assert.rejects(assertStagingSource({ ...environment, GITHUB_REF: "refs/heads/main" }, {
    ...dependencies(), fetch: async () => { fetched = true; return new Response(); },
  }), /refs\/heads\/staging/);
  assert.equal(fetched, false);
});

test("reports sanitized GitHub failures", async () => {
  await assert.rejects(assertStagingSource(environment, {
    ...dependencies(), fetch: async () => { throw new Error("secret upstream response"); },
  }), /Could not verify the current staging branch head/);
});
