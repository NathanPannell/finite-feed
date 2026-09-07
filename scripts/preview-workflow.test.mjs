import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { previewEnvironmentCreateArgs } from "./create-railway-preview-environment.mjs";

const workflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");

test("preview deploys the checked-out PR head through exact-source helpers", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_API_SERVICE_ID" api/);
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_WORKER_SERVICE_ID" worker/);
  assert.equal(workflow.match(/REQUIRE_WORKER_READY: "true"/g)?.length, 2);
});

test("a new Railway copy receives safe preview values before it can deploy", () => {
  assert.match(workflow, /node scripts\/create-railway-preview-environment\.mjs/);
  const args = previewEnvironmentCreateArgs({
    PREVIEW_ENVIRONMENT: "pr-21", PREVIEW_PULL_REQUEST: "21",
    RAILWAY_PROJECT_ID: "project", RAILWAY_BASE_ENVIRONMENT_ID: "base",
    RAILWAY_API_SERVICE_ID: "api", RAILWAY_WORKER_SERVICE_ID: "worker",
    PREVIEW_DATABASE_URL: "pooled", PREVIEW_DATABASE_URL_UNPOOLED: "unpooled",
  });
  for (const contract of [
    ["api", "variables.DATABASE_URL.value", "pooled"],
    ["api", "variables.DATABASE_URL_UNPOOLED.value", "unpooled"],
    ["worker", "variables.DATABASE_URL.value", "pooled"],
    ["worker", "variables.DELIVERY_ENABLED.value", "false"],
    ["api", "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview"],
    ["worker", "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview"],
  ]) {
    assert.ok(args.some((value, index) => value === contract[0] && args[index + 1] === contract[1] && args[index + 2] === contract[2]));
  }
});

test("cleanup uses provider enumeration and deployments carry exact provenance", () => {
  assert.match(workflow, /--meta previewRepository="\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /--meta previewPullRequest="\$PREVIEW_PULL_REQUEST"/);
  assert.match(workflow, /node scripts\/cleanup-previews\.mjs/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});
