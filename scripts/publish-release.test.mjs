import assert from "node:assert/strict";
import test from "node:test";

import { publishRelease } from "./publish-release.mjs";

const commit = "a".repeat(40);
const environment = { EXPECTED_COMMIT_SHA: commit, GITHUB_REPOSITORY: "owner/repository", GITHUB_TOKEN: "token" };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

test("creates the tag before the release and targets the verified commit", async () => {
  const writes = [];
  const release = await publishRelease(environment, {
    readFileSync: () => "0.1.0\n",
    fetch: async (url, options) => {
      if (url.endsWith("/git/ref/tags/v0.1.0")) return response({}, 404);
      if (url.endsWith("/releases/tags/v0.1.0")) return response({}, 404);
      writes.push({ url, body: JSON.parse(options.body) });
      return response(url.endsWith("/releases") ? { tag_name: "v0.1.0" } : { ref: "refs/tags/v0.1.0" }, 201);
    },
  });
  assert.equal(release.tag_name, "v0.1.0");
  assert.deepEqual(writes.map((write) => write.body), [
    { ref: "refs/tags/v0.1.0", sha: commit },
    { tag_name: "v0.1.0", target_commitish: commit, name: "v0.1.0", generate_release_notes: true },
  ]);
});

test("reuses a tag and release only when the tag points to the deployed commit", async () => {
  let writes = 0;
  const existing = await publishRelease(environment, {
    readFileSync: () => "0.1.0",
    fetch: async (url, options) => {
      if (options.method !== "GET") writes += 1;
      if (url.endsWith("/git/ref/tags/v0.1.0")) return response({ object: { type: "commit", sha: commit } });
      return response({ tag_name: "v0.1.0", html_url: "https://example.test/release" });
    },
  });
  assert.equal(existing.tag_name, "v0.1.0");
  assert.equal(writes, 0);
});

test("refuses a reused version tag on another commit", async () => {
  await assert.rejects(publishRelease(environment, {
    readFileSync: () => "0.1.0",
    fetch: async () => response({ object: { type: "commit", sha: "b".repeat(40) } }),
  }), /Refusing to reuse v0.1.0/);
});
