import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");

test("preview deploys the checked-out PR head through exact-source helpers", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_API_SERVICE_ID" api/);
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_WORKER_SERVICE_ID" worker/);
  assert.equal(workflow.match(/REQUIRE_WORKER_READY: "true"/g)?.length, 2);
});

test("a new Railway copy receives safe preview values before it can deploy", () => {
  for (const contract of [
    /RAILWAY_API_SERVICE_ID" variables\.DATABASE_URL\.value "\$PREVIEW_DATABASE_URL"/,
    /RAILWAY_API_SERVICE_ID" variables\.DATABASE_URL_UNPOOLED\.value "\$PREVIEW_DATABASE_URL_UNPOOLED"/,
    /RAILWAY_WORKER_SERVICE_ID" variables\.DATABASE_URL\.value "\$PREVIEW_DATABASE_URL"/,
    /RAILWAY_WORKER_SERVICE_ID" variables\.DELIVERY_ENABLED\.value false/,
    /RAILWAY_API_SERVICE_ID" variables\.TELEGRAM_PRODUCTION_BOT_TOKEN\.value disabled-in-preview/,
    /RAILWAY_WORKER_SERVICE_ID" variables\.TELEGRAM_PRODUCTION_BOT_TOKEN\.value disabled-in-preview/,
  ]) assert.match(workflow, contract);
});

test("cleanup uses provider enumeration and deployments carry exact provenance", () => {
  assert.match(workflow, /--meta previewRepository="\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /--meta previewPullRequest="\$PREVIEW_PULL_REQUEST"/);
  assert.match(workflow, /node scripts\/cleanup-previews\.mjs/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});
