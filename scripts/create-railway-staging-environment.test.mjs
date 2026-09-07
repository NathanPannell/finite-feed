import assert from "node:assert/strict";
import test from "node:test";
import { ensureRailwayStagingEnvironment, stagingEnvironmentCreateArgs } from "./create-railway-staging-environment.mjs";

const environment = {
  RAILWAY_ENVIRONMENT: "staging", RAILWAY_PROJECT_ID: "project", RAILWAY_BASE_ENVIRONMENT_ID: "production-id",
  RAILWAY_API_SERVICE_ID: "api", RAILWAY_WORKER_SERVICE_ID: "worker",
  STAGING_DATABASE_URL: "pooled", STAGING_DATABASE_URL_UNPOOLED: "direct",
};

test("new staging copy receives isolated database and delivery values atomically", () => {
  const args = stagingEnvironmentCreateArgs(environment);
  for (const contract of [
    ["api", "variables.DATABASE_URL.value", "pooled"],
    ["api", "variables.DATABASE_URL_UNPOOLED.value", "direct"],
    ["worker", "variables.DATABASE_URL.value", "pooled"],
    ["worker", "variables.DELIVERY_ENABLED.value", "false"],
    ["api", "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-staging"],
  ]) assert.ok(args.some((value, index) => value === contract[0] && args[index + 1] === contract[1] && args[index + 2] === contract[2]));
});

test("existing staging environment is reused without creation", async () => {
  const calls = [];
  const result = await ensureRailwayStagingEnvironment(environment, { execute: async (args) => {
    calls.push(args);
    return args[0] === "environment" ? JSON.stringify({ environments: [{ name: "production" }, { name: "staging" }] }) : "";
  }});
  assert.deepEqual(result, { created: false, attempts: 0 });
  assert.equal(calls.some((args) => args[0] === "environment" && args[1] === "new"), false);
});

test("missing staging is created once", async () => {
  const calls = [];
  const result = await ensureRailwayStagingEnvironment(environment, { execute: async (args) => {
    calls.push(args);
    return args[0] === "environment" && args[1] === "list" ? JSON.stringify({ environments: [{ name: "production" }] }) : "";
  }});
  assert.deepEqual(result, { created: true, attempts: 1 });
  assert.equal(calls.filter((args) => args[0] === "environment" && args[1] === "new").length, 1);
});

test("refuses any staging environment alias", () => {
  assert.throws(() => stagingEnvironmentCreateArgs({ ...environment, RAILWAY_ENVIRONMENT: "stage" }), /must be named staging/);
});

test("retries Railway's environment creation throttle without weakening isolation", async () => {
  let creates = 0;
  let sleeps = 0;
  const execute = async (args) => {
    if (args[0] === "environment" && args[1] === "list") return JSON.stringify({ environments: [{ name: "production" }] });
    if (args[0] === "environment" && args[1] === "new" && ++creates === 1) {
      const error = new Error("throttled");
      error.details = "You can only create 1 environment every 30 seconds";
      throw error;
    }
    return "";
  };
  const result = await ensureRailwayStagingEnvironment(environment, {
    execute, sleep: async () => { sleeps += 1; }, delayMs: 32_000, maxAttempts: 3,
  });
  assert.deepEqual(result, { created: true, attempts: 2 });
  assert.equal(sleeps, 1);
});
