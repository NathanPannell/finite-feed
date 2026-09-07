import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRailwayPreviewEnvironment,
  previewEnvironmentCreateArgs,
} from "./create-railway-preview-environment.mjs";

const environment = {
  PREVIEW_ENVIRONMENT: "pr-57",
  PREVIEW_PULL_REQUEST: "57",
  RAILWAY_PROJECT_ID: "project",
  RAILWAY_BASE_ENVIRONMENT_ID: "base",
  RAILWAY_API_SERVICE_ID: "api",
  RAILWAY_WORKER_SERVICE_ID: "worker",
  PREVIEW_DATABASE_URL: "postgresql://pooled/preview",
  PREVIEW_DATABASE_URL_UNPOOLED: "postgresql://unpooled/preview",
};

const emptyListing = JSON.stringify({ environments: [] });
const existingListing = JSON.stringify({ environments: [{ name: "pr-57" }] });

test("creation preserves every atomic preview isolation override", () => {
  assert.deepEqual(previewEnvironmentCreateArgs(environment), [
    "environment", "new", "pr-57",
    "--copy", "base",
    "--service-config", "api", "variables.DATABASE_URL.value", environment.PREVIEW_DATABASE_URL,
    "--service-config", "api", "variables.DATABASE_URL_UNPOOLED.value", environment.PREVIEW_DATABASE_URL_UNPOOLED,
    "--service-config", "api", "variables.PREVIEW_DATABASE_URL.value", environment.PREVIEW_DATABASE_URL,
    "--service-config", "api", "variables.PREVIEW_DATABASE_URL_UNPOOLED.value", environment.PREVIEW_DATABASE_URL_UNPOOLED,
    "--service-config", "api", "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", "api", "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview",
    "--service-config", "api", "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-preview",
    "--service-config", "worker", "variables.DATABASE_URL.value", environment.PREVIEW_DATABASE_URL,
    "--service-config", "worker", "variables.DATABASE_URL_UNPOOLED.value", environment.PREVIEW_DATABASE_URL_UNPOOLED,
    "--service-config", "worker", "variables.PREVIEW_DATABASE_URL.value", environment.PREVIEW_DATABASE_URL,
    "--service-config", "worker", "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", "worker", "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview",
    "--service-config", "worker", "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-preview",
  ]);
});

test("an existing exact environment is reused without creation", async () => {
  const calls = [];
  const result = await ensureRailwayPreviewEnvironment(environment, {
    execute: async (args) => {
      calls.push(args);
      return args[0] === "environment" ? existingListing : "";
    },
    log: () => {},
  });
  assert.deepEqual(result, { created: false, attempts: 0 });
  assert.equal(calls.filter((args) => args[1] === "new").length, 0);
});

test("a quota failure waits with deterministic jitter and retries", async () => {
  const calls = [];
  const sleeps = [];
  let creates = 0;
  const result = await ensureRailwayPreviewEnvironment(environment, {
    execute: async (args) => {
      calls.push(args);
      if (args[1] === "list") return emptyListing;
      if (args[1] === "new" && creates++ === 0) throw new Error("Workspace allows 1 environment every 30 seconds.");
      return "";
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    log: () => {},
    maxAttempts: 3,
  });
  assert.deepEqual(result, { created: true, attempts: 2 });
  assert.equal(calls.filter((args) => args[1] === "new").length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 30_000 && sleeps[0] < 39_000);
});

test("an ambiguous failed response rechecks and accepts the exact environment", async () => {
  let lists = 0;
  let sleeps = 0;
  const result = await ensureRailwayPreviewEnvironment(environment, {
    execute: async (args) => {
      if (args[1] === "list") return lists++ === 0 ? emptyListing : existingListing;
      if (args[1] === "new") throw new Error("connection closed");
      return "";
    },
    sleep: async () => { sleeps += 1; },
    log: () => {},
  });
  assert.deepEqual(result, { created: true, attempts: 1 });
  assert.equal(sleeps, 0);
});

test("a non-quota failure fails immediately without exposing provider output", async () => {
  let creates = 0;
  let sleeps = 0;
  await assert.rejects(
    ensureRailwayPreviewEnvironment(environment, {
      execute: async (args) => {
        if (args[1] === "list") return emptyListing;
        if (args[1] === "new") { creates += 1; throw new Error("permission denied: sensitive provider response"); }
        return "";
      },
      sleep: async () => { sleeps += 1; },
      log: () => {},
    }),
    (error) => /failed without a retryable quota response/.test(error.message) && !error.message.includes("sensitive"),
  );
  assert.equal(creates, 1);
  assert.equal(sleeps, 0);
});

test("quota retries remain bounded", async () => {
  let creates = 0;
  let sleeps = 0;
  await assert.rejects(
    ensureRailwayPreviewEnvironment(environment, {
      execute: async (args) => {
        if (args[1] === "list") return emptyListing;
        if (args[1] === "new") { creates += 1; throw new Error("Only 1 environment may be created every 30 seconds"); }
        return "";
      },
      sleep: async () => { sleeps += 1; },
      log: () => {},
      maxAttempts: 3,
    }),
    /remained throttled after 3 attempts/,
  );
  assert.equal(creates, 3);
  assert.equal(sleeps, 2);
});

test("unsafe or mismatched targets are rejected before provider calls", async () => {
  let calls = 0;
  await assert.rejects(
    ensureRailwayPreviewEnvironment({ ...environment, PREVIEW_ENVIRONMENT: "production" }, { execute: async () => { calls += 1; } }),
    /must match the pull request number/,
  );
  assert.equal(calls, 0);
});
