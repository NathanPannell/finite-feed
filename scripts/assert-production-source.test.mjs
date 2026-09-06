import assert from "node:assert/strict";
import test from "node:test";

import { assertProductionSource } from "./assert-production-source.mjs";

const environment = {
  EXPECTED_COMMIT_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "owner/repository",
  GITHUB_TOKEN: "token",
  GITHUB_REF: "refs/heads/main",
};

const dependencies = (remoteSha = environment.EXPECTED_COMMIT_SHA) => ({
  execFileSync: () => `${environment.EXPECTED_COMMIT_SHA}\n`,
  fetch: async () => ({ ok: true, json: async () => ({ object: { sha: remoteSha } }) }),
});

test("accepts the exact checked-out current main commit", async () => {
  await assertProductionSource(environment, dependencies());
});

test("rejects a manual dispatch from a non-main ref before querying GitHub", async () => {
  let queried = false;
  await assert.rejects(
    assertProductionSource({ ...environment, GITHUB_REF: "refs/heads/topic" }, {
      ...dependencies(),
      fetch: async () => { queried = true; return { ok: true, json: async () => ({}) }; },
    }),
    /restricted to refs\/heads\/main/,
  );
  assert.equal(queried, false);
});

test("rejects a commit superseded on main", async () => {
  await assert.rejects(assertProductionSource(environment, dependencies("b".repeat(40))), /Refusing stale production commit/);
});

test("rejects a checkout that differs from the workflow commit", async () => {
  await assert.rejects(
    assertProductionSource(environment, { ...dependencies(), execFileSync: () => `${"c".repeat(40)}\n` }),
    /does not match requested commit/,
  );
});
