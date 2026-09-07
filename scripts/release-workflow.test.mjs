import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const preview = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("CI covers both long-lived branches and gates production publication after verification", () => {
  assert.match(ci, /branches: \[main, staging\]/);
  assert.match(ci, /node scripts\/assert-production-source\.mjs/);
  assert.equal(ci.match(/node scripts\/assert-production-source\.mjs/g)?.length, 3);
  assert.ok(ci.indexOf("Revalidate main immediately before frontend promotion") < ci.indexOf("Deploy frontend once and resolve its production origin"));
  assert.ok(ci.lastIndexOf("node scripts/assert-production-source.mjs") < ci.indexOf("node scripts/publish-release.mjs"));
  assert.ok(ci.indexOf("Verify deployed frontend release metadata") < ci.indexOf("node scripts/publish-release.mjs"));
  assert.match(ci, /NEXT_PUBLIC_APP_ENV="production"/);
  assert.match(ci, /api\/version\?commit=\$EXPECTED_COMMIT_SHA/);
});

test("release preparation and validation use exact staging metadata", () => {
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /RELEASE_CANDIDATE_SHA: \$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(release, /ref: \$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(release, /node scripts\/validate-release-candidate\.mjs/);
  assert.match(release, /node scripts\/validate-release-pr\.mjs/);
  assert.doesNotMatch(release, /node scripts\/prepare-release\.mjs\s*$/m);
});

test("release PRs cannot create or clean up disposable feature previews", () => {
  assert.match(preview, /github\.event\.pull_request\.base\.ref == 'staging'/);
  assert.equal(preview.match(/github\.event\.pull_request\.base\.ref == 'staging'/g)?.length, 2);
});
