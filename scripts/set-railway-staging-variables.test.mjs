import assert from "node:assert/strict";
import test from "node:test";
import { stagingVariablePlans } from "./set-railway-staging-variables.mjs";

const environment = {
  RAILWAY_ENVIRONMENT: "staging", RAILWAY_PROJECT_ID: "project", RAILWAY_API_SERVICE_ID: "api", RAILWAY_WORKER_SERVICE_ID: "worker",
  STAGING_DATABASE_URL: "pooled", STAGING_DATABASE_URL_UNPOOLED: "direct", EXPECTED_COMMIT_SHA: "a".repeat(40),
  YOUTUBE_API_KEY: "youtube", NEON_AUTH_BASE_URL: "https://staging-auth.example/app/auth",
  VERCEL_OIDC_TEAM_SLUG: "team", VERCEL_OIDC_PROJECT_NAME: "finite-feed-staging", MATCH_LAB_COOKIE_SECRET: "x".repeat(32),
  TELEGRAM_DEVELOPER_BOT_TOKEN: "developer", TELEGRAM_WEBHOOK_SECRET: "webhook", DEVELOPER_TELEGRAM_USER_IDS: "123",
};

test("staging uses permanent database variables and strips production Telegram", () => {
  const [api, worker] = stagingVariablePlans(environment);
  assert.equal(api.target, "staging");
  assert.equal(api.values.DATABASE_URL, "pooled");
  assert.equal(api.values.DATABASE_URL_UNPOOLED, "direct");
  assert.equal(worker.values.DATABASE_URL, "pooled");
  assert.equal(worker.values.DELIVERY_ENABLED, "false");
  assert.equal(api.values.VERCEL_OIDC_ENVIRONMENT, "preview");
  for (const plan of [api, worker]) {
    assert.ok(plan.remove.includes("TELEGRAM_PRODUCTION_BOT_TOKEN"));
    assert.ok(plan.remove.includes("TELEGRAM_PRODUCTION_CHAT_ID"));
    assert.equal("TELEGRAM_PRODUCTION_BOT_TOKEN" in plan.values, false);
  }
});

test("optional staging secrets are deleted when absent", () => {
  const plans = stagingVariablePlans({ ...environment, TELEGRAM_DEVELOPER_BOT_TOKEN: "", OPENROUTER_API_KEY: "" });
  for (const plan of plans) {
    assert.ok(plan.remove.includes("TELEGRAM_DEVELOPER_BOT_TOKEN"));
    assert.ok(plan.remove.includes("OPENROUTER_API_KEY"));
  }
});

test("staging target is fixed and services must be distinct", () => {
  assert.throws(() => stagingVariablePlans({ ...environment, RAILWAY_ENVIRONMENT: "production" }), /must be named staging/);
  assert.throws(() => stagingVariablePlans({ ...environment, RAILWAY_WORKER_SERVICE_ID: "api" }), /distinct/);
});
