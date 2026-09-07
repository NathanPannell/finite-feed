import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/staging.yml", import.meta.url), "utf8");

test("staging deploy is serialized and restricted to the staging branch", () => {
  assert.match(workflow, /branches: \[staging\]/);
  assert.match(workflow, /group: finite-feed-staging/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /deploy-staging:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/staging'/);
  assert.ok((workflow.match(/node scripts\/assert-staging-source\.mjs/g) || []).length >= 3);
});

test("staging resources are permanent, deterministic, and isolated", () => {
  assert.match(workflow, /NEON_BRANCH: staging/);
  assert.doesNotMatch(workflow, /expires_at:/);
  assert.match(workflow, /RAILWAY_ENVIRONMENT: staging/);
  assert.match(workflow, /create-railway-staging-environment\.mjs/);
  assert.match(workflow, /set-railway-staging-variables\.mjs/);
  assert.match(workflow, /VERCEL_PROJECT_ID: \$\{\{ vars\.VERCEL_PROJECT_ID \}\}/);
  assert.doesNotMatch(workflow, /VERCEL_STAGING_PROJECT_ID/);
  assert.match(workflow, /all_except_custom_domains/);
  assert.match(workflow, /gitBranch == "staging"/);
  assert.match(workflow, /vercel deploy --target preview/);
  assert.match(workflow, /vercel alias set "\$deployment_url" "\$staging_host"/);
  assert.match(workflow, /Stable staging URL did not resolve to this deployment/);
  assert.match(workflow, /reconcile-neon-staging-domains\.mjs/);
});

test("staging pins service and frontend source and requires Google OAuth", () => {
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_API_SERVICE_ID" api/);
  assert.match(workflow, /deploy-railway-service\.sh "\$RAILWAY_WORKER_SERVICE_ID" worker/);
  assert.equal(workflow.match(/REQUIRE_WORKER_READY: "true"/g)?.length, 2);
  assert.match(workflow, /NEXT_PUBLIC_APP_VERSION="\$app_version"/);
  assert.match(workflow, /NEXT_PUBLIC_APP_ENV=staging/);
  assert.match(workflow, /--env NEXT_PUBLIC_APP_ENV=staging/);
  assert.match(workflow, /NEXT_PUBLIC_APP_COMMIT="\$EXPECTED_COMMIT_SHA"/);
  assert.match(workflow, /Verify Google OAuth accepts permanent staging callback/);
  assert.match(workflow, /verify-google-oauth-start\.mjs/);
});

test("staging never receives production Telegram configuration", () => {
  assert.doesNotMatch(workflow, /secrets\.TELEGRAM_PRODUCTION_BOT_TOKEN/);
  assert.doesNotMatch(workflow, /vars\.TELEGRAM_PRODUCTION_CHAT_ID/);
});
